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


// --- Helper: Get User Activity (Inbox Only) ---
async function getUserActivity(authClient, userEmail, startDate, endDate, pageToken = null) {
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // 1. Construct Query - STRICTLY INBOX
    // Using label:INBOX ensures we don't get Sent items or Trash
    let query = 'label:INBOX -in:trash -in:spam';

    // Simple date adjustment helper (YYYY-MM-DD format, no timezones)
    const adjustDate = (dateStr, days) => {
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day); // Local date
        date.setDate(date.getDate() + days);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    // Convert YYYY-MM-DD to YYYY/MM/DD for Gmail
    const formatForGmail = (dateStr) => dateStr.replace(/-/g, '/');

    try {
        if (startDate) {
            // Gmail's "after:" is exclusive, so subtract 1 day
            const adjustedStart = adjustDate(startDate, -1);
            query += ` after:${formatForGmail(adjustedStart)}`;
        }

        if (endDate) {
            // Gmail's "before:" is exclusive, so add 1 day
            const adjustedEnd = adjustDate(endDate, 1);
            query += ` before:${formatForGmail(adjustedEnd)}`;
        }
    } catch (e) {
        console.error("Date Query Build Failed:", e.message);
        throw e;
    }

    console.log(`[Gmail Query] User: ${userEmail} | Query: [${query}]`);

    let allMessages = [];
    let nextToken = null;
    let totalEstimate = 0;
    let exactTotal = 0;

    // --- NEW: Exact Count Logic (First Request Only) ---
    // If this is the first page (no pageToken), we count EVERYTHING first.
    if (!pageToken) {
        console.log(`[Count] Starting exact THREAD count for ${userEmail}...`);
        try {
            let tempToken = null;
            let pageCount = 0;
            const uniqueThreads = new Set();

            do {
                const res = await gmail.users.messages.list({
                    userId: 'me',
                    q: query,
                    maxResults: 500,
                    pageToken: tempToken,
                    fields: 'nextPageToken,messages(threadId)' // Optimize: Fetch Thread IDs
                });

                const msgs = res.data.messages || [];
                msgs.forEach(m => uniqueThreads.add(m.threadId));

                tempToken = res.data.nextPageToken;
                pageCount++;
                if (pageCount > 50) break;
            } while (tempToken);

            exactTotal = uniqueThreads.size;
            console.log(`[Count] Exact Thread Total: ${exactTotal}`);
        } catch (e) {
            console.error("Count failed", e);
        }
    }

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

                const data = await analyzeThread(threadDetails.data, gmail);
                if (data) {
                    // Strict date filtering based on user's selected range
                    let isValid = true;

                    if (startDate || endDate) {
                        // Extract just the date part from the email timestamp (YYYY-MM-DD)
                        const emailDate = new Date(data.sort_epoch);
                        // FIX: Use local time instead of UTC (toISOString) to avoid 1-day offset
                        const y = emailDate.getFullYear();
                        const m = String(emailDate.getMonth() + 1).padStart(2, '0');
                        const d = String(emailDate.getDate()).padStart(2, '0');
                        const emailDateStr = `${y}-${m}-${d}`;

                        if (startDate) {
                            const userStartDate = startDate.split('T')[0]; // Ensure YYYY-MM-DD format
                            if (emailDateStr < userStartDate) isValid = false;
                        }

                        if (endDate && isValid) {
                            const userEndDate = endDate.split('T')[0]; // Ensure YYYY-MM-DD format
                            if (emailDateStr > userEndDate) isValid = false;
                        }
                    }

                    if (isValid) {
                        detailedEmails.push(data);
                    }
                }
            } catch (e) {
                console.warn(`Error processing thread ${threadMsgs[0].threadId}:`, e.message);
            }
        }));
    }

    // Sort by latest first
    detailedEmails.sort((a, b) => b.sort_epoch - a.sort_epoch);

    console.log(`[Result] Filtered Down To: ${detailedEmails.length} emails (from ${allMessages.length} fetched)`);
    console.log(`[Result] Exact Total Meta: ${exactTotal}`);

    // Meta attachment
    // FAIL-SAFE: Total cannot be less than what we actually fetched and are returning.
    const finalTotal = Math.max(exactTotal, detailedEmails.length, totalEstimate);

    detailedEmails.meta = {
        fetched: allMessages.length,
        nextToken,
        total: finalTotal,
        query_debug: query
    };

    return detailedEmails;
}

// --- Helper: Analyze a Whole Thread ---
// --- Helper: Analyze a Whole Thread (Simplified) ---
async function analyzeThread(threadData, gmail) {
    if (!threadData || !threadData.messages) return null;
    const messages = threadData.messages;
    if (messages.length === 0) return null;

    // SORTING: Gmail usually returns chronologically, but let's be safe.
    messages.sort((a, b) => parseInt(a.internalDate) - parseInt(b.internalDate));

    // We want the LATEST message for the Date/Timestamp.
    const latestMsg = messages[messages.length - 1];

    // IDENTIFY PRIMARY (First Incoming Message)
    const primaryMsg = messages[0];

    // --- TIMESTAMPS ---
    const latestTs = parseInt(latestMsg.internalDate, 10);
    // const timestamp = new Date(latestTs).toISOString(); // Removed to avoid confusion

    // --- FROM / SENDER ---
    // Use Primary Message (First Incoming) to identify the Counterparty
    let fromHeaders = primaryMsg.payload?.headers;

    // Fallback: If primary message details are missing (lite fetch), try to get them
    if (!fromHeaders && primaryMsg.id !== latestMsg.id) {
        try {
            const pmFull = await gmail.users.messages.get({ userId: 'me', id: primaryMsg.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
            fromHeaders = pmFull.data.payload?.headers;
        } catch (e) {
            // console.warn("Failed to fetch primary msg headers"); 
        }
    }
    // Final fallback to latest if still nothing
    if (!fromHeaders) fromHeaders = latestMsg.payload?.headers;

    const fromRaw = fromHeaders?.find(h => h.name === 'From')?.value || 'Unknown';
    const fromEmail = fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw.replace(/"/g, '').trim();
    // For display, use Name if possible, else Email
    const fromName = fromRaw.split('<')[0].replace(/"/g, '').trim() || fromEmail;

    // --- SUBJECT ---
    const subjectRaw = fromHeaders?.find(h => h.name === 'Subject')?.value || '(No Subject)';

    // --- SUMMARY ---
    const summary = latestMsg.snippet || "";

    // --- ANALYSIS ---
    // 1. Is Inbox? (Inbound message exists) - With Query label:INBOX this is effectively always true, but we keep the flag.
    const isInbox = messages.some(m => !m.labelIds.includes('SENT'));

    // 2. Replied Check (v5.39 Strict Logic)
    let replied = false;
    const primaryIsInbound = !primaryMsg.labelIds.includes('SENT');
    const latestIsOutbound = latestMsg.labelIds.includes('SENT');

    // Fix: Must have >1 message to be a "Reply" conversation
    if (messages.length > 1 && primaryIsInbound && latestIsOutbound) {
        replied = true;
    }

    return {
        id: threadData.id,
        snippet: summary,
        historyId: latestMsg.historyId,
        valid: true,
        sort_epoch: latestTs,  // Gmail's raw timestamp (milliseconds since epoch)
        timestamp: latestTs,    // Same raw timestamp for compatibility
        from: fromName,
        subject: subjectRaw,
        analysis: {
            is_inbox: isInbox, // Keeping for frontend compat
            is_replied: replied
        }
    };
}


module.exports = { listAllUsers, getUserActivity };
