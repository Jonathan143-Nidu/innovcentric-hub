require('dotenv').config();
const express = require('express');
const cors = require('cors');
// const { createWorkspaceClient } = require('./src/auth'); // Unused and potentially invalid import

// Global Crash Handler for Debugging
process.on('uncaughtException', (err) => {
    console.error('CRITICAL STARTUP ERROR:', err);
    console.error(err.stack);
});

console.log('Booting innovcentric-hub backend v5.2...');

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
        return res.status(401).json({ error: `Unauthorized: ${error.message}` });
    }
};

// basic health check (optional, but good to keep)
app.get('/health', (req, res) => {
    res.send('innovcentric Workspace Hub Backend is Running 🚀');
});

const { listAllUsers, getUserActivity } = require('./src/workspace');

// --- New Endpoint: Get All Users (for Dropdown) ---
// PROTECTED BY AUTH
app.get('/users', verifyGoogleToken, async (req, res) => {
    try {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// The Main "One Click" Endpoint
// PROTECTED BY AUTH
app.post('/collect-data', verifyGoogleToken, async (req, res) => {
    try {
        console.log('Received request to collect data...');
        const { startDate, endDate, targetEmail } = req.body;

        const ADMIN_EMAIL = 'hiring@innovcentric.com';
        const DOMAIN = 'innovcentric.com';

        let usersToProcess = [];

        if (targetEmail && targetEmail !== 'Select User' && targetEmail !== 'All Users') {
            console.log(`Targeting single user: ${targetEmail}`);
            // Fetch name for this specific user if possible, or just use email as name
            let allData = [];
            let nextToken = null;

            if (targetEmail === 'All Users' || targetEmail === 'all') {
                // 1. Get All Users
                const users = await listAllUsers(DOMAIN, ADMIN_EMAIL);
                console.log(`[API] Fetching all users (${users.length})...`);

                // 2. Loop through users and get their data (Parallel)
                const promises = users.map(async (user) => {
                    if (user.suspended) return null;
                    try {
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
                            error: err.message
                        };
                    }
                });

                const results = await Promise.all(promises);
                allData = results.filter(r => r !== null);

            } else {
                // Paginated Single User
                const result = await getUserActivity(authClient, targetEmail, startDate, endDate, pageToken);
                allData = result;
                nextToken = result.meta?.nextToken;
            }

            // Calculate Stats
            let inboxCount = 0;
            let fetchedCount = 0;

            if (targetEmail === 'All Users' || targetEmail === 'all') {
                // Aggregate from all employees
                allData.forEach(emp => {
                    if (emp.activities) {
                        fetchedCount += emp.activities.meta?.fetched || 0;
                        inboxCount += emp.activities.filter(e => e.analysis && e.analysis.is_inbox).length;
                    }
                });
            } else {
                // Single User (allData is array of emails)
                fetchedCount = allData.meta?.fetched || 0;
                inboxCount = allData.filter(e => e.analysis && e.analysis.is_inbox).length;
            }

            const stats = {
                fetched: fetchedCount,
                analyzed: allData.length, // For single user this is # of emails. For all users this is # of employees.
                nextToken: nextToken,
                inbox: inboxCount
            };
            res.json({ success: true, version: "v4.5", stats, data: allData });
        } catch (error) {
            console.error('Error collecting data:', error);
            res.status(500).json({ error: error.message });
        }
    });

// Catch-all handler for any request that doesn't match an API route
// Sends back the React index.html configuration

app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log("Verification: v2.5 Online (500 limit, Real Sender Names)");
});
