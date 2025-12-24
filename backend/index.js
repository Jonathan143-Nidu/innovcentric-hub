require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createWorkspaceClient } = require('./src/auth');

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
        const ALLOWED_EMAILS = ['hiring@innovcentric.com', 'ganesh@innovcentric.com', 'jonathan@innovcentric.com'];

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
            usersToProcess = [{
                primaryEmail: targetEmail,
                name: { fullName: targetEmail } // Placeholder name
            }];
        } else {
            // 1. Get All Users
            const users = await listAllUsers(DOMAIN, ADMIN_EMAIL);
            console.log(`Found ${users.length} users.`);
            usersToProcess = users;
        }

        // 2. Loop through users and get their data
        const allData = [];

        for (const user of usersToProcess) {
            // Skip suspended users if needed
            if (user.suspended) continue;

            try {
                // Pass startDate and endDate from the request body
                const activities = await getUserActivity(user.primaryEmail, req.body.startDate, req.body.endDate);

                allData.push({
                    employee_name: user.name.fullName,
                    employee_email: user.primaryEmail,
                    department: user.orgUnitPath || 'General',
                    activities: activities
                });
            } catch (err) {
                console.error(`Failed to fetch data for ${user.primaryEmail}:`, err.message);
                // Push partial error data so we see it in dashboard
                allData.push({
                    employee_name: user.name.fullName,
                    employee_email: user.primaryEmail,
                    error: err.message || "Unknown Error"
                });
            }
        }

        res.json({ success: true, data: allData });
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
