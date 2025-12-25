import React, { useState, useEffect } from 'react';
import { GoogleLogin } from '@react-oauth/google';

// --- Helper Hook for Sorting ---
const useSortedData = (items, config = null) => {
  const [sortConfig, setSortConfig] = React.useState(config);

  const sortedItems = React.useMemo(() => {
    let sortableItems = [...items];
    if (sortConfig !== null) {
      sortableItems.sort((a, b) => {
        let aKey = a[sortConfig.key];
        let bKey = b[sortConfig.key];

        // Handle Dates (sort_epoch preferred)
        if (sortConfig.key === 'date' && a.sort_epoch && b.sort_epoch) {
          aKey = a.sort_epoch;
          bKey = b.sort_epoch;
        }

        if (aKey < bKey) return sortConfig.direction === 'ascending' ? -1 : 1;
        if (aKey > bKey) return sortConfig.direction === 'ascending' ? 1 : -1;
        return 0;
      });
    }
    return sortableItems;
  }, [items, sortConfig]);

  const requestSort = (key) => {
    let direction = 'ascending';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending';
    }
    setSortConfig({ key, direction });
  };

  return { items: sortedItems, requestSort, sortConfig };
};

const SortIcon = ({ direction }) => {
  if (!direction) return <span className="text-gray-300 ml-1">⇅</span>;
  return direction === 'ascending' ? <span className="text-blue-600 ml-1">↑</span> : <span className="text-blue-600 ml-1">↓</span>;
};


function App() {
  // Auth State
  const [token, setToken] = useState(null);

  // Dynamic Data State
  const [userList, setUserList] = useState([]);
  const [selectedUser, setSelectedUser] = useState('all'); // 'all' or specific email
  const [activeTab, setActiveTab] = useState('dashboard'); // 'dashboard', 'inbox', 'sent', 'rtr'

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);

  // Data Lists
  const [userRows, setUserRows] = useState([]); // For "All Users" summary
  const [resumeList, setResumeList] = useState([]); // For "Sent" tab (Resumes)
  const [inboxList, setInboxList] = useState([]); // For "Inbox" tab
  const [rtrList, setRtrList] = useState([]);     // For "RTR" tab

  // KPI Totals
  const [totals, setTotals] = useState({ inbox: 0, sent: 0, rtrs: 0, resumes: 0 });

  // Init Sorting Hooks
  const { items: sortedInbox, requestSort: sortInbox, sortConfig: inboxSort } = useSortedData(inboxList, { key: 'date', direction: 'descending' });
  const { items: sortedResumes, requestSort: sortResumes, sortConfig: resumeSort } = useSortedData(resumeList, { key: 'date', direction: 'descending' });

  // Login Handlers
  const handleLoginSuccess = (credentialResponse) => {
    setToken(credentialResponse.credential);
  };

  const handleLoginError = () => {
    alert("Login Failed. Please try again.");
  };

  // Load User List
  useEffect(() => {
    if (!token) return;
    fetch('/users', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => {
        if (res.status === 401) setToken(null);
        return res.json();
      })
      .then(data => {
        if (data && data.success) setUserList(data.users);
      })
      .catch(err => console.error("Load users failed:", err));
  }, [token]);


  // Main Data Collection
  const handleCollectData = async () => {
    setLoading(true);
    // Clear previous
    setResumeList([]);
    setInboxList([]);
    setRtrList([]);

    try {
      const response = await fetch(`/collect-data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          startDate,
          endDate,
          targetEmail: selectedUser === 'all' ? 'All Users' : selectedUser
        })
      });
      const result = await response.json();

      if (result.success) {
        // 1. Process "All Users" Rows
        const newRows = result.data.map(emp => {
          if (emp.error) return { name: emp.employee_name, inbox: 0, sent: 0, rtrs: 0, error: emp.error };
          const acts = emp.activities || [];
          return {
            name: emp.employee_name,
            inbox: acts.filter(a => a.analysis && a.analysis.is_inbox).length,
            sent: acts.filter(a => a.analysis && a.analysis.is_sent).length,
            rtrs: acts.filter(a => a.analysis && a.analysis.is_rtr).length
          };
        });
        setUserRows(newRows);

        // 2. Flatten Data for Tabs
        let allResumes = [];
        let allInbox = [];
        let allRTRs = [];
        const seenIds = new Set(); // Deduplication

        result.data.forEach(emp => {
          if (!emp.error && emp.activities) {
            emp.activities.forEach(email => {
              if (seenIds.has(email.id)) return; // Skip duplicates
              seenIds.add(email.id);

              const dateStr = new Date(email.updated_at || email.timestamp).toLocaleString('en-US', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: true, timeZoneName: 'short'
              });

              // Inbox
              if (email.analysis && email.analysis.is_inbox) {
                allInbox.push({
                  sort_epoch: email.sort_epoch || new Date(email.updated_at || email.timestamp).getTime(),
                  date: dateStr,
                  sender: email.analysis.sender_name || "Unknown",
                  subject: email.analysis.role_display || (email.snippet ? email.snippet.substring(0, 50) + "..." : "No Subject"),
                  replied: email.analysis.replied ? "Yes" : "No",
                  summary: email.analysis.summary || email.snippet || ""
                });
              }

              // RTR
              if (email.analysis && email.analysis.is_rtr) {
                const ai = email.ai_data || {};
                allRTRs.push({
                  employer: ai.client || "Unknown",
                  position: ai.position || email.subject,
                  candidate: ai.candidate || emp.employee_name,
                  rate: ai.rate || "N/A",
                  client: ai.client || "Unknown",
                  location: ai.location || "Unknown",
                  vendor: ai.vendor || "-"
                });
              }

              // Resumes (Sent)
              if (email.analysis && email.analysis.has_resume && email.analysis.is_sent) {
                email.analysis.resume_filenames.forEach(fname => {
                  allResumes.push({
                    sort_epoch: email.sort_epoch || new Date(email.updated_at || email.timestamp).getTime(),
                    date: dateStr,
                    to: "Client/Vendor", // simplified
                    position: email.subject,
                    attachment: fname,
                    status: "Sent"
                  });
                });
              }
            });
          }
        });

        setInboxList(allInbox); // No need to pre-sort heavily here if using hooks, but good to have default
        setRtrList(allRTRs);
        setResumeList(allResumes);

        // 3. Totals
        setTotals({
          inbox: newRows.reduce((a, b) => a + b.inbox, 0),
          sent: newRows.reduce((a, b) => a + b.sent, 0),
          rtrs: newRows.reduce((a, b) => a + b.rtrs, 0),
          resumes: allResumes.length
        });

        alert("Data Updated!");

      } else {
        alert("Error: " + result.error);
      }
    } catch (error) {
      console.error(error);
      alert("Connection Failed.");
    }
    setLoading(false);
  };

  // Login Screen
  if (!token) {
    return (
      <div className="h-screen flex flex-col justify-center items-center bg-gray-100">
        <div className="bg-white p-10 rounded-xl shadow-lg text-center">
          <h1 className="text-2xl font-bold text-blue-600 mb-4">Innovcentric Admin Hub</h1>
          <p className="text-gray-500 mb-6">Please sign in with your corporate email.</p>
          <div className="flex justify-center">
            <GoogleLogin onSuccess={handleLoginSuccess} onError={handleLoginError} useOneTap />
          </div>
        </div>
      </div>
    );
  }

  // Dashboard UI
  return (
    <div className="flex h-screen bg-gray-100 font-sans">

      {/* SIDEBAR */}
      <aside className="w-72 bg-white border-r p-6 space-y-6 flex flex-col">
        <h1 className="text-xl font-bold text-blue-600">Innovcentric Hub</h1>

        {/* User Select */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase">User Scope</label>
          <select
            value={selectedUser}
            onChange={(e) => {
              setSelectedUser(e.target.value);
              // If switching to specific user, maybe auto-select 'inbox' or keep dashboard?
              // For now user manually picks tab.
            }}
            className="w-full mt-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Users</option>
            {userList.map(u => <option key={u.email} value={u.email}>{u.name}</option>)}
          </select>
        </div>

        {/* Date Filters */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-gray-500 uppercase">Date Range</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </div>

        {/* Action Button */}
        <button
          onClick={handleCollectData}
          disabled={loading}
          className={`w-full py-2 px-4 rounded text-white font-medium transition-colors ${loading ? 'bg-blue-400' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          {loading ? 'Collecting...' : '⚡ Collect Data'}
        </button>

        <hr className="border-gray-200" />

        {/* Navigation Tabs */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Views</label>
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${activeTab === 'dashboard' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              📊 Dashboard Summary
            </button>
            <button
              onClick={() => setActiveTab('inbox')}
              className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${activeTab === 'inbox' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              📥 Inbox ({totals.inbox})
            </button>
            <button
              onClick={() => setActiveTab('sent')}
              className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${activeTab === 'sent' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              📤 Resumes Sent ({totals.resumes})
            </button>
            <button
              onClick={() => setActiveTab('rtr')}
              className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${activeTab === 'rtr' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              📝 RTRs ({totals.rtrs})
            </button>
          </nav>
        </div>

        <div className="mt-auto">
          <button onClick={() => setToken(null)} className="text-sm text-gray-500 hover:text-red-500">Logout</button>
        </div>
      </aside>

      {/* MAIN CONTENT Area */}
      <main className="flex-1 p-8 overflow-y-auto">

        {/* TOP KPI CARDS (Always Visible or conditional? User asked for hidden in specific views, but usually KPIs are good at top) */}
        {/* Let's follow the user's HTML logic: Card changes based on view, but general Dash has all 4 */}

        {activeTab === 'dashboard' && (
          <>
            <div className="grid grid-cols-4 gap-6 mb-8">
              <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-100">
                <p className="text-sm text-gray-500 font-medium">Total Inbox</p>
                <p className="text-3xl font-bold text-gray-800 mt-2">{totals.inbox}</p>
              </div>
              <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-100">
                <p className="text-sm text-gray-500 font-medium">Total Sent</p>
                <p className="text-3xl font-bold text-gray-800 mt-2">{totals.sent}</p>
              </div>
              <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-100">
                <p className="text-sm text-gray-500 font-medium">RTRs Detected</p>
                <p className="text-3xl font-bold text-gray-800 mt-2">{totals.rtrs}</p>
              </div>
              <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-100">
                <p className="text-sm text-gray-500 font-medium">Resumes Submitted</p>
                <p className="text-3xl font-bold text-blue-600 mt-2">{totals.resumes}</p>
              </div>
            </div>

            {/* ALL USERS SUMMARY TABLE */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-800">Team Activity Report</h2>
              </div>
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-500 font-medium border-b">
                  <tr>
                    <th className="px-6 py-3">Employee</th>
                    <th className="px-6 py-3">Inbox</th>
                    <th className="px-6 py-3">Sent</th>
                    <th className="px-6 py-3">RTRs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-900">{row.name}</td>
                      <td className="px-6 py-3">{row.inbox}</td>
                      <td className="px-6 py-3">{row.sent}</td>
                      <td className="px-6 py-3">{row.rtrs}</td>
                    </tr>
                  ))}
                  {userRows.length === 0 && (
                    <tr><td colSpan="4" className="px-6 py-8 text-center text-gray-400">No data collected yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* INBOX TABLE */}
        {activeTab === 'inbox' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-800">Inbox Log</h2>
            </div>
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-gray-500 font-medium border-b cursor-pointer select-none">
                <tr>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortInbox('date')}>
                    Date {inboxSort?.key === 'date' && <SortIcon direction={inboxSort.direction} />}
                  </th>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortInbox('sender')}>
                    Sender Name {inboxSort?.key === 'sender' && <SortIcon direction={inboxSort.direction} />}
                  </th>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortInbox('subject')}>
                    Subject (Role) {inboxSort?.key === 'subject' && <SortIcon direction={inboxSort.direction} />}
                  </th>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortInbox('replied')}>
                    Replied? {inboxSort?.key === 'replied' && <SortIcon direction={inboxSort.direction} />}
                  </th>
                  <th className="px-6 py-3">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedInbox.length > 0 ? sortedInbox.map((item, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{item.date}</td>
                    <td className="px-6 py-3 font-medium text-gray-800">{item.sender}</td>
                    <td className="px-6 py-3 text-blue-600 font-medium">{item.subject}</td>
                    <td className="px-6 py-3">
                      {item.replied ?
                        <span className="bg-green-100 text-green-700 px-2 py-1 rounded text-xs">Yes</span> :
                        <span className="bg-gray-100 text-gray-500 px-2 py-1 rounded text-xs">No</span>
                      }
                    </td>
                    <td className="px-6 py-3 text-gray-500 max-w-xs truncate" title={item.summary}>{item.summary}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-400">No inbox data found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* SENT RESUMES TABLE */}
        {activeTab === 'sent' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-800">Resumes Submitted</h2>
            </div>
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-gray-500 font-medium border-b cursor-pointer select-none">
                <tr>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortResumes('date')}>
                    Date {resumeSort?.key === 'date' && <SortIcon direction={resumeSort.direction} />}
                  </th>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortResumes('position')}>
                    Position (Subject) {resumeSort?.key === 'position' && <SortIcon direction={resumeSort.direction} />}
                  </th>
                  <th className="px-6 py-3">Resume File</th>
                  <th className="px-6 py-3 hover:bg-gray-100" onClick={() => sortResumes('status')}>
                    Status {resumeSort?.key === 'status' && <SortIcon direction={resumeSort.direction} />}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedResumes.length > 0 ? sortedResumes.map((item, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-6 py-3 text-gray-500">{item.date}</td>
                    <td className="px-6 py-3 text-gray-800">{item.position}</td>
                    <td className="px-6 py-3 text-blue-600 cursor-pointer hover:underline">{item.attachment}</td>
                    <td className="px-6 py-3 text-green-600 font-medium">{item.status}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="4" className="px-6 py-8 text-center text-gray-400">No resumes sent.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* RTR TABLE */}
        {activeTab === 'rtr' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-800">RTR Tracking</h2>
            </div>
            <table className="w-full text-sm text-left whitespace-nowrap">
              <thead className="bg-gray-50 text-gray-500 font-medium border-b">
                <tr>
                  <th className="px-6 py-3">Candidate</th>
                  <th className="px-6 py-3">Role</th>
                  <th className="px-6 py-3">Client</th>
                  <th className="px-6 py-3">Vendor</th>
                  <th className="px-6 py-3">Location</th>
                  <th className="px-6 py-3">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rtrList.length > 0 ? rtrList.map((item, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-6 py-3 font-medium text-gray-800">{item.candidate}</td>
                    <td className="px-6 py-3 text-gray-600 truncate max-w-xs">{item.position}</td>
                    <td className="px-6 py-3 text-blue-600">{item.client}</td>
                    <td className="px-6 py-3 text-gray-500">{item.vendor}</td>
                    <td className="px-6 py-3 text-gray-500">{item.location}</td>
                    <td className="px-6 py-3 text-gray-800 font-mono">{item.rate}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="6" className="px-6 py-8 text-center text-gray-400">No RTRs detected.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

      </main>
      {/* DEBUG BADGE */}

    </div>
  );
}

export default App;
