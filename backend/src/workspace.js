const { google } = require('googleapis');
const { getImpersonatedClient } = require('./auth');

// --- Helper: List all users in the domain ---
async function listAllUsers(domain, adminEmail) {
    // We need a client acting as an Admin to list users.
    if (!adminEmail) {
        throw new Error("Admin Email is required to list users.");
    }

    console.log(`Listing users using admin: ${adminEmail} for domain: ${domain} `);
    const authClient = await getImpersonatedClient(adminEmail);
    const service = google.admin({ version: 'directory_v1', auth: authClient });

    const res = await service.users.list({
        domain: domain,
        customer: 'my_customer',
        maxResults: 50,
        orderBy: 'email',
    });

    return res.data.users || [];
}

// --- Helper: Convert Local Date String to US/Eastern Epoch Seconds ---
function getEasternEpoch(dateString, isEnd = false) {
    if (!dateString) return null;

    const [y, m, d] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 5, 0, 0)); // 5 AM UTC -> ~Midnight EST

    if (isEnd) {
        date.setDate(date.getDate() + 1);
    }

    return Math.floor(date.getTime() / 1000); // Return seconds
}

// --- Helper: Get User Activity (Inbox + Sent) ---
// --- Helper: Get User Activity (Inbox + Sent) ---
async function getUserActivity(authClient, userEmail, startDate, endDate, pageToken = null) {
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // 0. Get Labels (for RTR detection) - fail soft
    const rtrLabelIds = new Set();
    try {
        const labelsRes = await gmail.users.labels.list({ userId: 'me' });
        const labels = labelsRes.data.labels || [];
        labels.forEach(l => {
            if (l.name.toLowerCase().includes('rtr') || l.name.toLowerCase().includes('submission')) {
                rtrLabelIds.add(l.id);
            }
        });
    } catch (e) {
        console.warn(`[Labels] Failed to fetch labels for ${userEmail}: ${e.message}`);
    }

    // 1. Construct Query
    let query = '-in:trash -in:spam -in:drafts';
    if (startDate) {
        const startStr = startDate.replace(/-/g, '/');
        query += ` after:${startStr}`;
    }
    if (endDate) {
        const d = new Date(endDate);
        d.setDate(d.getDate() + 1);
        const nextDay = d.toISOString().split('T')[0].replace(/-/g, '/');
        query += ` before:${nextDay}`;
    }

    let allMessages = [];
    let nextToken = null;
    let totalEstimate = 0;

    // 2. Single Page Fetch
    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 100,
            pageToken: pageToken
        });
        allMessages = res.data.messages || [];
        nextToken = res.data.nextPageToken || null;
        totalEstimate = res.data.resultSizeEstimate || 0;
    } catch (e) {
        console.error(`Error listing messages for ${userEmail}:`, e.message);
        throw e;
    }

    const detailedEmails = [];

    // 3. Process Logic
    // Processing threads in batches...
    const threadMap = new Map();
    allMessages.forEach(msg => {
        if (!threadMap.has(msg.threadId)) threadMap.set(msg.threadId, []);
        threadMap.get(msg.threadId).push(msg);
    });

    const threadsToProcess = Array.from(threadMap.values());
    const chunkSize = 10;

    for (let i = 0; i < threadsToProcess.length; i += chunkSize) {
        const chunk = threadsToProcess.slice(i, i + chunkSize);
        await Promise.all(chunk.map(async (threadMsgs) => {
            const threadId = threadMsgs[0].threadId;
            try {
                // Fetch Thread Metadata
                const threadDetails = await gmail.users.threads.get({
                    userId: 'me',
                    id: threadId,
                    format: 'metadata',
                    metadataHeaders: ['From', 'Subject', 'Date']
                });

                // Analyze
                const analysis = await analyzeThread(threadDetails.data, rtrLabelIds, authClient, gmail);
                if (analysis) detailedEmails.push(analysis);

            } catch (e) {
                console.error(`Error processing thread ${threadId}:`, e.message);
            }
        }));
    }

    // Sort
    detailedEmails.sort((a, b) => b.sort_epoch - a.sort_epoch);

    // Meta attachment (Javascript array property hack to pass stats)
    detailedEmails.meta = { fetched: allMessages.length, nextToken, total: totalEstimate };

    return detailedEmails;
}

// --- Helper: Analyze a Whole Thread ---
async function analyzeThread(threadData, rtrLabelIds, authClient, gmail) {
    if (!threadData || !threadData.messages) return null;
    const messages = threadData.messages;
    if (messages.length === 0) return null;

    // FIND THE "PRIMARY" MESSAGE (The one we received, to get Sender/Subject)
    // We look for the first message that is NOT sent by us.
    // If all are sent by us (e.g. we started thread), use the first one.
    const primaryMsg = messages.find(m => !m.labelIds.includes('SENT')) || messages[0];

    // console.log(`[DEBUG] Thread ${threadData.id} | Msgs: ${messages.length} | Primary: ${primaryMsg.id}`);

    let payload = primaryMsg.payload || {};
    let headers = payload.headers || [];

    // FALLBACK: If Thread details were partial (no headers), fetch the specific message
    if (headers.length === 0) {
        console.log(`[WARN] Thread ${threadData.id} missing headers. Fetching metadata for ${primaryMsg.id}...`);
        try {
            // Using passed 'gmail' instance for efficiency
            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: primaryMsg.id,
                format: 'metadata',
                metadataHeaders: ['From', 'Date', 'Subject']
            });
            payload = fullMsg.data.payload || {};
            headers = payload.headers || [];
            console.log(`[RECOVERED] Found ${headers.length} headers after fallback.`);
        } catch (e) {
            console.error(`[ERROR] Failed to recover message ${primaryMsg.id}: ${e.message}`);
        }
    }

    const subjectRaw = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
    // Parse From header: "Name <email>" -> Extract Email ID
    const fromRaw = headers.find(h => h.name === 'From')?.value || 'Unknown';
    // Regex to extract email inside <...>, or fallback to the raw string if no brackets
    const fromEmail = fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw.replace(/"/g, '').trim();
    // User requested Email ID instead of Name
    const fromName = fromEmail;

    // Date: Normalized to ISO from Internal Date (Epoch) for accuracy
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
    let replied = false;
    let resumeFiles = [];

    // Analyze thread for statuses
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

        // Strict Inbox Check
        if (labelIds.includes('INBOX')) isInbox = true;
    });

    // ROLE EXTRACTION
    let roleDisplay = subjectRaw;
    if (isRtr) {
        roleDisplay = "RTR";
    } else {
        let clean = subjectRaw.replace(/^(Fwd|Re|Aw|Fw):\s*/i, '').trim();
        const match = clean.match(/^([^|\-:]+)/);
        if (match && match[1] && match[1].length < 50) {
            roleDisplay = match[1].trim();
        } else {
            roleDisplay = clean;
        }
    }

    const result = {
        id: threadData.id,
        timestamp: timestamp,
        subject: roleDisplay,
        original_subject: subjectRaw,
        from: fromName,
        summary: summary,
        updated_at: timestamp,
        sort_epoch: parseInt(primaryMsg.internalDate, 10),
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
        let combinedBody = "";
        const recentMsgs = messages.slice(-2);

        recentMsgs.forEach(m => {
            const bodyPart = getEmailBody(m);
            combinedBody += bodyPart + "\n\n---\n\n";
        });

        // console.log(`[AI] Analyzing Thread RTR: ${subjectRaw}`);
        try {
            const aiResult = await require('./ai').extractRTRDetails(combinedBody, subjectRaw);
            result.ai_data = aiResult;
        } catch (e) {
            console.warn(`[AI] Skipped for ${threadData.id}: ${e.message}`);
        }
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

// --- Helper: Analyze Email Content (Single Message Fallback) ---
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
    const isInbox = labelIds.includes('INBOX');

    // Check for RTR
    const subLower = subject.toLowerCase();
    let isRtr = subLower.includes('rtr') || subLower.includes('right to represent');

    if (!isRtr && labelIds.length > 0) {
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
