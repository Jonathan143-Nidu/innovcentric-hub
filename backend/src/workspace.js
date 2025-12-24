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
    let query = '-in:trash -in:spam -in:drafts';

    if (startDate) {
        // Use 'after:' with Epoch Seconds for precision
        const startEpoch = getEasternEpoch(startDate, false);
        query += ` after:${startEpoch}`;
    }
    if (endDate) {
        // Use 'before:' with Epoch Seconds (Next Day Midnight)
        const endEpoch = getEasternEpoch(endDate, true);
        query += ` before:${endEpoch}`;
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
    // or just aggregate the thread logic.
    // LIMIT: Process restricted number of threads to prevent timeouts.
    const threads = Array.from(threadMap.values()).slice(0, 50); // Process latest 50 threads only for speed

    await Promise.all(threads.map(async (threadMsgs) => {
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
            const analysis = await analyzeThread(threadDetails.data, rtrLabelIds, authClient);
            if (analysis) detailedEmails.push(analysis);

        } catch (e) {
            console.error(`Error fetching thread ${threadId}: ${e.message}`);
        }
    }));

    return detailedEmails;
}

// --- Helper: Analyze a Whole Thread ---
async function analyzeThread(threadData, rtrLabelIds, authClient) {
    const messages = threadData.messages || [];
    if (messages.length === 0) return null;

    // Get latest message for display dates/subjects
    const latestMsg = messages[messages.length - 1];
    const payload = latestMsg.payload || {};
    const headers = payload.headers || [];

    const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
    const dateStr = headers.find(h => h.name === 'Date')?.value;

    // Aggregate Statuses across the whole thread
    let hasResume = false;
    let isRtr = false;
    let isSent = false;
    let isInbox = false;
    let resumeFiles = [];

    // Check all messages in the thread
    messages.forEach(msg => {
        const p = msg.payload || {};
        const labelIds = msg.labelIds || [];

        // Resume Check
        if (p.parts) {
            const files = p.parts
                .filter(part => part.filename && part.filename.length > 0)
                .map(part => part.filename)
                .filter(name => name.toLowerCase().includes('resume') || name.toLowerCase().includes('cv'));
            if (files.length > 0) {
                hasResume = true;
                resumeFiles.push(...files);
            }
        }

        // RTR Check (Subject or Label on ANY message)
        const sub = (p.headers?.find(h => h.name === 'Subject')?.value || '').toLowerCase();
        if (sub.includes('rtr') || sub.includes('right to represent')) isRtr = true;
        if (labelIds.some(id => rtrLabelIds.has(id))) isRtr = true;

        // Inbox/Sent Logic for Thread:
        // If *any* message was sent by us, the thread has "Sent" activity.
        // If *any* message is Inbox, it has "Inbox" activity.
        if (labelIds.includes('SENT')) isSent = true;
        // Strict Inbox Check: Only if textually labeled 'INBOX'
        if (labelIds.includes('INBOX')) isInbox = true;
    });

    const result = {
        id: threadData.id, // Use Thread ID
        timestamp: dateStr || new Date().toISOString(),
        subject: subject,
        from: "Thread View", // Placeholder
        analysis: {
            has_resume: hasResume,
            resume_filenames: [...new Set(resumeFiles)],
            is_rtr: isRtr,
            is_sent: isSent, // Thread contains sent items
            is_inbox: isInbox // Thread contains received items
        }
    };

    // AI ENHANCEMENT FOR RTR THREADS
    if (isRtr) {
        // Concatenate the last few messages to give AI context
        let combinedBody = "";
        // Take last 2 messages for context
        const recentMsgs = messages.slice(-2);

        // This requires getEmailBody helper (assume it exists in scope or passed)
        // We will do a rough extract here or rely on the loop.
        // For simplicity in this edit, we skip body extraction here to keep it clean
        // or we need to move getEmailBody up or duplicate.
        // Let's assume the previous getEmailBody is available.

        recentMsgs.forEach(m => {
            // Use the helper to get the FULL body, not just the snippet
            const bodyPart = getEmailBody(m);
            combinedBody += bodyPart + "\n\n---\n\n";
        });

        console.log(`[AI] Analyzing Thread RTR: ${subject}`);
        const aiResult = await require('./ai').extractRTRDetails(combinedBody, subject);
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
        resumeFiles = payload.parts
            .filter(part => part.filename && part.filename.length > 0)
            .map(part => part.filename)
            .filter(name => name.toLowerCase().includes('resume') || name.toLowerCase().includes('cv'));
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
