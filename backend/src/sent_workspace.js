const { google } = require('googleapis');

// --- Helper: Get User SENT Activity ---
async function getUserSentActivity(authClient, userEmail, startDate, endDate, pageToken = null) {
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // 1. Construct Query - STRICTLY SENT
    let query = 'label:SENT -in:trash -in:spam';

    // Simple date adjustment helper (YYYY-MM-DD format)
    const adjustDate = (dateStr, days) => {
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day); // Local date
        date.setDate(date.getDate() + days);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    const formatForGmail = (dateStr) => dateStr.replace(/-/g, '/');

    try {
        if (startDate) {
            const adjustedStart = adjustDate(startDate, -1);
            query += ` after:${formatForGmail(adjustedStart)}`;
        }
        if (endDate) {
            const adjustedEnd = adjustDate(endDate, 1);
            query += ` before:${formatForGmail(adjustedEnd)}`;
        }
    } catch (e) {
        console.error("Date Query Build Failed:", e.message);
        throw e;
    }

    console.log(`[Gmail Sent Query] User: ${userEmail} | Query: [${query}]`);

    let allMessages = [];
    let nextToken = null;
    let totalEstimate = 0;
    let exactTotal = 0;

    // --- Exact Count Logic (First Request Only) ---
    if (!pageToken) {
        console.log(`[Count] Starting exact SENT THREAD count for ${userEmail}...`);
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
                    fields: 'nextPageToken,messages(threadId)'
                });

                const msgs = res.data.messages || [];
                msgs.forEach(m => uniqueThreads.add(m.threadId));

                tempToken = res.data.nextPageToken;
                pageCount++;
                if (pageCount > 50) break; // Safety limit
            } while (tempToken);

            exactTotal = uniqueThreads.size;
            console.log(`[Count] Exact Sent Thread Total: ${exactTotal}`);
        } catch (e) {
            console.error("Sent Count failed", e);
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
        console.error(`Error listing sent messages for ${userEmail}:`, e.message);
        throw e;
    }

    const detailedEmails = [];

    // 3. Process Logic
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
                const threadDetails = await gmail.users.threads.get({
                    userId: 'me',
                    id: threadId,
                    format: 'metadata',
                    metadataHeaders: ['To', 'Subject', 'Date'] // Start fetching 'To'
                });

                const data = await analyzeSentThread(threadDetails.data, gmail);
                if (data) {
                    let isValid = true;
                    if (startDate || endDate) {
                        const emailDate = new Date(data.sort_epoch);
                        const y = emailDate.getFullYear();
                        const m = String(emailDate.getMonth() + 1).padStart(2, '0');
                        const d = String(emailDate.getDate()).padStart(2, '0');
                        const emailDateStr = `${y}-${m}-${d}`;

                        if (startDate) {
                            const userStartDate = startDate.split('T')[0];
                            if (emailDateStr < userStartDate) isValid = false;
                        }

                        if (endDate && isValid) {
                            const userEndDate = endDate.split('T')[0];
                            if (emailDateStr > userEndDate) isValid = false;
                        }
                    }

                    if (isValid) {
                        detailedEmails.push(data);
                    }
                }
            } catch (e) {
                console.warn(`Error processing sent thread ${threadMsgs[0].threadId}:`, e.message);
            }
        }));
    }

    detailedEmails.sort((a, b) => b.sort_epoch - a.sort_epoch);

    // FAIL-SAFE
    const finalTotal = Math.max(exactTotal, detailedEmails.length, totalEstimate);

    detailedEmails.meta = {
        fetched: allMessages.length,
        nextToken,
        total: finalTotal,
        query_debug: query
    };

    return detailedEmails;
}

// --- Helper: Analyze a Whole SENT Thread ---
async function analyzeSentThread(threadData, gmail) {
    if (!threadData || !threadData.messages) return null;
    const messages = threadData.messages;
    if (messages.length === 0) return null;

    messages.sort((a, b) => parseInt(a.internalDate) - parseInt(b.internalDate));

    // For Sent items, we want the Timestamp of the LAST message created by ME (usually the last one if recent)
    // But safely: just use the last message in the thread as the interaction time
    const latestMsg = messages[messages.length - 1];

    const latestTs = parseInt(latestMsg.internalDate, 10);

    // --- RECIPIENT (To) ---
    // Instead of 'From', we want to know who we sent it TO.
    // We look at the headers of the LATEST message (representing the latest action)
    let headers = latestMsg.payload?.headers;

    // If missing, fetch
    if (!headers) {
        try {
            const fullMsg = await gmail.users.messages.get({ userId: 'me', id: latestMsg.id, format: 'metadata', metadataHeaders: ['To', 'Subject'] });
            headers = fullMsg.data.payload?.headers;
        } catch (e) { }
    }

    // Extract 'To'
    const toRaw = headers?.find(h => h.name === 'To')?.value || 'Unknown Recipient';
    const toEmail = toRaw.match(/<([^>]+)>/)?.[1] || toRaw.replace(/"/g, '').trim();
    // Use Name if possible
    const toName = toRaw.split('<')[0].replace(/"/g, '').trim() || toEmail;

    // --- SUBJECT ---
    const subjectRaw = headers?.find(h => h.name === 'Subject')?.value || '(No Subject)';
    const summary = latestMsg.snippet || "";

    return {
        id: threadData.id,
        snippet: summary,
        historyId: latestMsg.historyId,
        valid: true,
        sort_epoch: latestTs,
        timestamp: latestTs,
        from: toName,         // Mapped to 'from' so frontend can reuse the "Sender/Name" column
        subject: subjectRaw,
        analysis: {
            is_inbox: true,   // Keeping true so frontend counts it as a valid item in the list
            is_sent: true,    // New flag
            is_replied: false // Not applicable really for sent items in this view
        }
    };
}

module.exports = { getUserSentActivity };
