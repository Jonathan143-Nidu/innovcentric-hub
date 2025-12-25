require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Helper to reliably format errors as strings
const formatError = (err) => {
    if (!err) return "Unknown Error (Null/Undefined)";
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    return JSON.stringify(err);
};

// Global Crash Handler for Debugging
process.on('uncaughtException', (err) => {
    console.error('CRITICAL STARTUP ERROR:', err);
    console.error(err.stack);
});

console.log('Booting innovcentric-hub backend v5.15...');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Serve Static Frontend Files (Secure Hosting)
app.use(express.static(path.join(__dirname, 'public')));

// --- Custom Auth Middleware (Google Sign-In) ---
const { OAuth2Client } = require('google-auth-library');
// Hardcoded Client ID (from user chat earlier)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const secureClient = new OAuth2Client(CLIENT_ID);

const verifyGoogleToken = async (req, res, next) => {
    // 1. Get Token from Header
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('Blocked: No token provided');
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const token = authHeader.split(' ')[1];

    try {
        // 2. Verify Token with Google
        const ticket = await secureClient.verifyIdToken({
            idToken: token,
            audience: CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const userEmail = payload['email'];

        // 3. Authorization Check (Allow list)
        // Allow ONLY hiring@innovcentric.com (or add others here)
        const ALLOWED_EMAILS = ['hiring@innovcentric.com', 'pc@innovcentric.com', 'jt@innovcentric.com', 'raja@innovcentric.com'];

        if (ALLOWED_EMAILS.includes(userEmail)) {
            console.log(`Access Granted to: ${userEmail}`);
            req.user = payload; // Attach user info
            next();
        } else {
            console.warn(`Blocked: Unauthorized email ${userEmail}`);
            return res.status(403).json({ error: 'Access Denied: Your email is not authorized.' });
        }
    } catch (error) {
        console.error('Token Verification Failed:', error.message);
        return res.status(401).json({ error: `Unauthorized: ${formatError(error)}` });
    }
};

// basic health check (optional, but good to keep)
app.get('/health', (req, res) => {
    res.send('innovcentric Workspace Hub Backend is Running 🚀');
});

// Import Modules Safe Load
let listAllUsers, getUserActivity, getImpersonatedClient;
try {
    ({ listAllUsers, getUserActivity } = require('./src/workspace'));
    ({ getImpersonatedClient } = require('./src/auth'));
} catch (e) {
    console.error("CRITICAL: Failed to load modules:", e);
}

// --- New Endpoint: Get All Users (for Dropdown) ---
// PROTECTED BY AUTH
app.get('/users', verifyGoogleToken, async (req, res) => {
    try {
        if (!listAllUsers) throw new Error("Backend Module 'workspace.js' failed to load.");

        const ADMIN_EMAIL = 'hiring@innovcentric.com';
        const DOMAIN = 'innovcentric.com';
        const users = await listAllUsers(DOMAIN, ADMIN_EMAIL);
        // Return simple list for dropdown
        const simpleUsers = users.map(u => ({
            name: u.name.fullName,
            email: u.primaryEmail
        }));
        res.json({ success: true, users: simpleUsers });
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ success: false, error: formatError(error) });
    }
});

// The Main "One Click" Endpoint
// PROTECTED BY AUTH
app.post('/collect-data', verifyGoogleToken, async (req, res) => {
    try {
        if (!getImpersonatedClient) throw new Error("Backend Module 'auth.js' failed to load.");
        if (!getUserActivity) throw new Error("Backend Module 'workspace.js' failed to load.");

        console.log('Received request to collect data...');
        const { startDate, endDate, targetEmail } = req.body;

        const ADMIN_EMAIL = 'hiring@innovcentric.com';
        const DOMAIN = 'innovcentric.com';

        let allData = [];
        let nextToken = null;

        // Validation
        if (!targetEmail || targetEmail === 'Select User') {
            return res.json({ success: false, error: "Please select a user." });
        }

        console.log(`[API] Processing request for: ${targetEmail}`);

        if (targetEmail === 'All Users' || targetEmail === 'all') {
            // 1. Get All Users
            const users = await listAllUsers(DOMAIN, ADMIN_EMAIL);
            console.log(`[API] Fetching all users (${users.length})...`);

            // 2. Loop through users and get their data (Parallel)
            const promises = users.map(async (user) => {
                if (user.suspended) return null;
                try {
                    // Impersonate THIS user to access their data
                    const authClient = await getImpersonatedClient(user.primaryEmail);
                    const acts = await getUserActivity(authClient, user.primaryEmail, startDate, endDate);
                    return {
                        employee_name: user.name.fullName,
                        employee_email: user.primaryEmail,
                        department: user.orgUnitPath || 'General',
                        activities: acts
                    };
                } catch (err) {
                    return {
                        employee_name: user.name.fullName,
                        employee_email: user.primaryEmail,
                        error: formatError(err)
                    };
                }
            });

            const results = await Promise.all(promises);
            allData = results.filter(r => r !== null);

        } else {
            // Paginated Single User
            const authClient = await getImpersonatedClient(targetEmail);
            const result = await getUserActivity(authClient, targetEmail, startDate, endDate, req.body.pageToken);
            allData = result;
            nextToken = result.meta?.nextToken;
        }

        // Calculate Stats
        let inboxCount = 0;
        let fetchedCount = 0;

        if (targetEmail === 'All Users' || targetEmail === 'all') {
            // Aggregate from all employees
            allData.forEach(emp => {
                if (emp.activities && Array.isArray(emp.activities)) {
                    fetchedCount += emp.activities.meta?.fetched || 0;
                    inboxCount += emp.activities.filter(e => e.analysis && e.analysis.is_inbox).length;
                }
            });
        } else {
            // Single User (allData is array of emails)
            fetchedCount = allData.meta?.fetched || 0;
            inboxCount = Array.isArray(allData) ? allData.filter(e => e.analysis && e.analysis.is_inbox).length : 0;
        }

        const stats = {
            fetched: fetchedCount,
            analyzed: allData.length,
            nextToken: nextToken,
            inbox: inboxCount,
            total: allData.meta?.total // Pass total estimate through
        };

        res.json({ success: true, version: "v5.15", stats, data: allData });

    } catch (error) {
        console.error('Error collecting data:', error);
        res.status(500).json({ error: formatError(error) });
    }
});

// Catch-all handler for any request that doesn't match an API route
// Sends back the React index.html configuration

app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// DEBUG: Expose source code to verify deployment version
app.get('/debug/source', (req, res) => {
    try {
        if (!getUserActivity) return res.send("getUserActivity is not loaded.");
        res.send(`<pre>${getUserActivity.toString()}</pre>`);
    } catch (e) {
        res.send(e.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log("Verification: v5.19 Online (Debug Source Route Active)");
});
