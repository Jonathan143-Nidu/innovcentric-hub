const { google } = require('googleapis');
const { getImpersonatedClient } = require('./auth');

// --- Helper: List all users in the domain ---
async function listAllUsers(domain, adminEmail) {
    // We need a client acting as an Admin to list users.
    // Ideally, use a Super Admin's email here for the 'subject'.
    // For now, we'll assume the environment provided client can do this 
    // OR we need the user to configure an "Admin Email" to impersonate.

    // Strategy: The service account itself can't list users unless it impersonates an Admin.
    // We will ask the caller to provide an admin email or configure it.
    if (!adminEmail) {
        throw new Error("Admin Email is required to list users.");
    }

    console.log(`Listing users using admin: ${adminEmail} for domain: ${domain} `);
    const authClient = await getImpersonatedClient(adminEmail);
    const service = google.admin({ version: 'directory_v1', auth: authClient });

    const res = await service.users.list({
        domain: domain,
        customer: 'my_customer', // 'my_customer' is a confusing alias for "the current account"
        maxResults: 50, // Limit for safety
        orderBy: 'email',
    });

    return res.data.users || [];
}

// --- Helper: Get Sent Emails for a User ---
// --- Helper: Get User Activity (Inbox + Sent) ---
// --- Helper: Convert Local Date String to US/Eastern Epoch Seconds ---
function getEasternEpoch(dateString, isEnd = false) {
    // dateString format: "YYYY-MM-DD"
    // We treat the input string as if it's "YYYY-MM-DD" in US/Eastern.
    // So if user selects "2025-12-22", we want the epoch for "2025-12-22 00:00:00 EST"

    // Create date assuming midnight in UTC first, then adjust.
    // Or simpler: Use a library, but since we want to avoid deps, we'll do string parsing.

    if (!dateString) return null;

    const [y, m, d] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 5, 0, 0)); // 5 AM UTC is roughly Midnight EST (ignoring DST for simplicity or strictly following UTC-5)

    // Better Approach: Force the time to be interpreted as NY Time
    // Since we can't easily rely on server locale, we will just format it to seconds.
    // Users want "USA Time", so let's rely on Gmail's native timezone handling if we can,
    // OR just use UTC seconds which Gmail accepts.

    // Let's stick to standard YYYY/MM/DD but ensure we cover the FULL 24h cycle
    // by adding a day for the end date.

    if (isEnd) {
        date.setDate(date.getDate() + 1);
    }

    return Math.floor(date.getTime() / 1000); // Return seconds
}

// --- Helper: Get User Activity (Inbox + Sent) ---
async function getUserActivity(userEmail, startDate, endDate) {
    console.log(`Fetching activity for: ${userEmail} `);
    const authClient = await getImpersonatedClient(userEmail);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // 0. Fetch User's Labels (To find "RTR", "Submission", "Rate Confirmation")
    let rtrLabelIds = new Set();
    try {
        const labelRes = await gmail.users.labels.list({ userId: 'me' });
        const labels = labelRes.data.labels || [];
        const targetNames = ['rtr', 'rate confirmation', 'submission', 'submissions', 'rate confirmed'];

        labels.forEach(l => {
            if (l.name && targetNames.some(t => l.name.toLowerCase().includes(t))) {
                rtrLabelIds.add(l.id);
            }
        });
        console.log(`[Labels] Found ${rtrLabelIds.size} relevant labels for RTR detection (User: ${userEmail})`);
    } catch (e) {
        console.warn(`[Labels] Failed to fetch labels for ${userEmail}: ${e.message}`);
    }

    // 1. Construct Query
    // CHANGED: Search "All Mail" (including Archived), excluding Trash/Spam/Drafts.
    // CHANGED: Use native YYYY/MM/DD for better timezone handling (respects mailbox timezone)
    let query = '-in:trash -in:spam -in:drafts';

    if (startDate) {
        // YYYY-MM-DD -> YYYY/MM/DD
        const startStr = startDate.replace(/-/g, '/');
        query += ` after:${startStr}`;
    }
    if (endDate) {
        // Increment End Date by 1 day to make it inclusive (because 'before:' is exclusive)
        const d = new Date(endDate);
        d.setDate(d.getDate() + 1);
        const nextDay = d.toISOString().split('T')[0].replace(/-/g, '/');
        query += ` before:${nextDay}`;
    }

    console.log(`[Query] ${userEmail}: ${query}`);

    let allMessages = [];
    let nextPageToken = null;
    let pageCount = 0;

    // 2. Paginated Fetch Loop
    do {
        try {
            const res = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 500, // Max allowed per page
                pageToken: nextPageToken
            });

            const msgs = res.data.messages || [];
            allMessages = allMessages.concat(msgs);
            nextPageToken = res.data.nextPageToken;

            pageCount++;
            console.log(`  - Page ${pageCount}: Fetched ${msgs.length} messages.`);

            // Safety Break (Optional: Prevent Infinite Loops if thousands)
            if (pageCount > 20) break; // Limit to ~10k emails to prevent timeout

        } catch (e) {
            console.error(`Error listing messages for ${userEmail}:`, e.message);
            throw e;
        }
    } while (nextPageToken);

    console.log(`  - Total Messages Found: ${allMessages.length}`);
    const detailedEmails = [];

    // 3. Process Threads (Group by ThreadId)
    // We already have all messages. Now let's group them first.
    const threadMap = new Map();

    allMessages.forEach(msg => {
        if (!threadMap.has(msg.threadId)) {
            threadMap.set(msg.threadId, []);
        }
        threadMap.get(msg.threadId).push(msg);
    });

    console.log(`  - Unique Threads: ${threadMap.size}`);

    // Process each thread to find the "Best" representative message for each category
    // LIMIT: Increased to 500 to capture more data.
    const threadsToProcess = Array.from(threadMap.values()).slice(0, 500);

    // Batch processing to avoid Gmail Rate Limits (Chunk size: 10)
    const chunkSize = 10;
    for (let i = 0; i < threadsToProcess.length; i += chunkSize) {
        const chunk = threadsToProcess.slice(i, i + chunkSize);

        await Promise.all(chunk.map(async (threadMsgs) => {
            // We typically want the LATEST message in the thread to get current status
            // But we might need to scan the whole thread to see if *any* message has a Resume or RTR.

            // Let's just grab the FULL thread details from Google to get the whole conversation context
            // This is expensive but accurate.
            const threadId = threadMsgs[0].threadId;

            try {
                const threadDetails = await gmail.users.threads.get({
                    userId: 'me',
                    id: threadId,
                    format: 'full'
                });

                // Analyze the Thread as a Whole
                const analysis = await analyzeThread(threadDetails.data, rtrLabelIds, authClient, gmail);
                if (analysis) detailedEmails.push(analysis);

            } catch (e) {
                console.error(`Error fetching thread ${threadId}: ${e.message}`);
            }
        }));
    }

    // Sort by Date Descending (Newest First)
    detailedEmails.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return detailedEmails;
}

// --- Helper: Analyze a Whole Thread ---
// --- Helper: Analyze a Whole Thread ---
async function analyzeThread(threadData, rtrLabelIds, authClient, gmail) {
    if (!threadData || !threadData.messages) return null;
    const messages = threadData.messages;
    if (messages.length === 0) return null;

    console.log(`[BACKEND v4.2] Analyzing Thread ${threadData.id}`);

    // FIND THE "PRIMARY" MESSAGE (The one we received, to get Sender/Subject)
    // We look for the first message that is NOT sent by us.
    // If all are sent by us (e.g. we started thread), use the first one.
    const primaryMsg = messages.find(m => !m.labelIds.includes('SENT')) || messages[0];

    console.log(`[DEBUG] Thread ${threadData.id} | Msgs: ${messages.length} | Primary: ${primaryMsg.id}`);

    let payload = primaryMsg.payload || {};
    let headers = payload.headers || [];

    // FALLBACK: If Thread details were partial (no headers), fetch the specific message
    if (headers.length === 0) {
        console.log(`[WARN] Thread ${threadData.id} missing headers. Fetching full message ${primaryMsg.id}...`);
        try {
            // Using passed 'gmail' instance for efficiency
            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: primaryMsg.id,
                format: 'full'
            });
            payload = fullMsg.data.payload || {};
            headers = payload.headers || [];
            console.log(`[RECOVERED] Found ${headers.length} headers after fallback.`);
        } catch (e) {
            console.error(`[ERROR] Failed to recover message ${primaryMsg.id}: ${e.message}`);
        }
    }

    console.log(`[DEBUG] Headers Found: ${headers.length} | Keys: ${headers.map(h => h.name).join(', ')}`);

    const headerKeys = headers.map(h => h.name);
    const subjectRaw = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
    // Parse From header: "Name <email>" -> "Name"
    const fromRaw = headers.find(h => h.name === 'From')?.value || 'Unknown';
    const fromName = fromRaw.split('<')[0].replace(/"/g, '').trim();

    // Date: Normalized to ISO from Internal Date (Epoch) for accuracy
    // Header 'Date' is unreliable for sorting.
    const internalDate = parseInt(primaryMsg.internalDate, 10);
    const dateRaw = headers.find(h => h.name === 'Date')?.value;
    const timestamp = !isNaN(internalDate)
        ? new Date(internalDate).toISOString()
        : (dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString());

    // Summary (Snippet)
    const summary = primaryMsg.snippet || "";

    // Aggregate Statuses across the whole thread
    let hasResume = false;
    let isRtr = false;
    let isSent = false;
    let isInbox = false;
    let replied = false; // "Replied Status"
    let resumeFiles = [];

    // Analyze thread for statuses
    // Check if WE replied: If there is a SENT message AFTER a RECEIVED message? 
    // Simplify: If thread contains both SENT and RECEIVED, we likely replied or they replied.
    // Strict "Replied": If we have a SENT message.
    const hasSentMsg = messages.some(m => m.labelIds.includes('SENT'));
    const hasReceivedMsg = messages.some(m => !m.labelIds.includes('SENT'));
    if (hasSentMsg && hasReceivedMsg) {
        replied = true;
    }

    // Check all messages in the thread for flags
    messages.forEach(msg => {
        const p = msg.payload || {};
        const labelIds = msg.labelIds || [];

        // Resume Check
        if (p.parts) {
            const files = p.parts
                .filter(part => part.filename && part.filename.length > 0)
                .map(part => part.filename);

            // Filter by keywords
            const keywords = ['resume', 'cv', 'profile', 'candidate', 'submission'];
            const validResumes = files.filter(name => keywords.some(k => name.toLowerCase().includes(k)));

            if (validResumes.length > 0) {
                hasResume = true;
                resumeFiles.push(...validResumes);
            }
        }

        // RTR Check
        const sub = (p.headers?.find(h => h.name === 'Subject')?.value || '').toLowerCase();
        if (sub.includes('rtr') || sub.includes('right to represent')) isRtr = true;
        if (labelIds.some(id => rtrLabelIds.has(id))) isRtr = true;

        if (labelIds.includes('SENT')) isSent = true;

        // Strict Inbox Check (as requested previously)
        if (labelIds.includes('INBOX')) isInbox = true;
    });

    // ROLE EXTRACTION
    let roleDisplay = subjectRaw;
    if (isRtr) {
        roleDisplay = "RTR";
    } else {
        // Simple Heuristic: Remove "Fwd:", "Re:", split by common separators
        let clean = subjectRaw.replace(/^(Fwd|Re|Aw|Fw):\s*/i, '').trim();
        // Take part before first dash, pipe, or colon if sensible length
        // Regex: Match text until -, |, : or end.
        const match = clean.match(/^([^|\-:]+)/);
        if (match && match[1] && match[1].length < 50) { // arbitrary length check
            roleDisplay = match[1].trim();
        } else {
            roleDisplay = clean;
        }
    }

    const result = {
        id: threadData.id,
        timestamp: timestamp,
        subject: roleDisplay, // User asked for "Role only"
        original_subject: subjectRaw, // Keep original available
        from: fromName,
        summary: summary,
        updated_at: timestamp,
        sort_epoch: parseInt(primaryMsg.internalDate, 10), // Flawless Numeric Sort Key
        analysis: {
            has_resume: hasResume,
            resume_filenames: [...new Set(resumeFiles)],
            is_rtr: isRtr,
            is_sent: isSent,
            is_inbox: isInbox,
            is_replied: replied
        }
    };

    // AI ENHANCEMENT FOR RTR THREADS
    if (isRtr) {
        // Concatenate the last few messages to give AI context
        let combinedBody = "";
        // Take last 2 messages for context
        const recentMsgs = messages.slice(-2);

        recentMsgs.forEach(m => {
            // Use the helper to get the FULL body, not just the snippet
            const bodyPart = getEmailBody(m);
            combinedBody += bodyPart + "\n\n---\n\n";
        });

        console.log(`[AI] Analyzing Thread RTR: ${subjectRaw}`);
        const aiResult = await require('./ai').extractRTRDetails(combinedBody, subjectRaw);
        result.ai_data = aiResult;
    }

    return result;
}

// --- Helper: Extract Plain Text Body ---
function getEmailBody(messageData) {
    let body = "";
    const payload = messageData.payload;

    if (payload.body && payload.body.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload.parts) {
        // Find text/plain part
        const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart && textPart.body && textPart.body.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        } else {
            // Fallback: Just join any part that has data (naive)
            payload.parts.forEach(p => {
                if (p.body && p.body.data) {
                    body += Buffer.from(p.body.data, 'base64').toString('utf-8') + "\n";
                }
            });
        }
    }
    return body;
}

// --- Helper: Analyze Email Content ---
function analyzeEmail(messageData, rtrLabelIds = new Set()) {
    const payload = messageData.payload || {};
    const headers = payload.headers || [];

    // Get basic info
    const subjectHeader = headers.find(h => h.name === 'Subject');
    const fromHeader = headers.find(h => h.name === 'From');
    const toHeader = headers.find(h => h.name === 'To');
    const dateHeader = headers.find(h => h.name === 'Date');

    const subject = subjectHeader ? subjectHeader.value : '(No Subject)';
    const from = fromHeader ? fromHeader.value : 'Unknown';
    const to = toHeader ? toHeader.value : 'Unknown';
    const date = dateHeader ? dateHeader.value : new Date().toISOString();

    // Check for Attachments (Resumes)
    let resumeFiles = [];
    if (payload.parts) {
        // Keywords to identify a Resume/Submission
        const keywords = ['resume', 'cv', 'profile', 'candidate', 'submission'];

        resumeFiles = payload.parts
            .filter(part => part.filename && part.filename.length > 0)
            .map(part => part.filename)
            .filter(name => {
                const lowerName = name.toLowerCase();
                return keywords.some(k => lowerName.includes(k));
            });
    }

    // Detect if Sent or Inbox
    const labelIds = messageData.labelIds || [];
    const isSent = labelIds.includes('SENT');
    // CHANGED: Strict Inbox check.
    const isInbox = labelIds.includes('INBOX');

    // Check for RTR
    // 1. Subject Check
    const subLower = subject.toLowerCase();
    let isRtr = subLower.includes('rtr') || subLower.includes('right to represent');

    // 2. Label Check (NEW)
    if (!isRtr && labelIds.length > 0) {
        // Check if any of this email's labels match our target list
        isRtr = labelIds.some(id => rtrLabelIds.has(id));
    }

    return {
        id: messageData.id,
        timestamp: date,
        to: to,
        subject: subject,
        analysis: {
            has_resume: resumeFiles.length > 0,
            resume_filenames: resumeFiles,
            is_rtr: isRtr,
            is_sent: isSent,
            is_inbox: isInbox
        }
    };
}

module.exports = { listAllUsers, getUserActivity };
