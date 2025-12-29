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

function App() {
  // Auth State
  const [token, setToken] = useState(null);

  // Dynamic Data State
  const [userList, setUserList] = useState([]);
  const [selectedUser, setSelectedUser] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('inbox'); // 'inbox' or 'sent'
  const [stats, setStats] = useState({});
  const [notification, setNotification] = useState(null); // { type: 'success'|'error', title, message }


  // Data Lists
  const [userRows, setUserRows] = useState([]);
  const [inboxList, setInboxList] = useState([]);
  const [totals, setTotals] = useState({ inbox: 0 });

  // Auto-dismiss notification
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Init Sorting Hooks
  const { items: sortedInbox } = useSortedData(inboxList, { key: 'date', direction: 'descending' });

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
        if (data && data.success) {
          setUserList(data.users);
        } else {
          console.error("Load users data error:", data);
        }
      })
      .catch(err => {
        console.error("Load users failed:", err);
        alert(`Failed to load users: ${err.message}`);
      });
  }, [token]);

  // Main Data Collection
  const handleCollectData = async (pageToken = null) => {
    setLoading(true);

    if (!pageToken) {
      setCurrentPage(1);
      setInboxList([]);
      setUserRows([]);
      setTotals({ inbox: 0 });
    }

    try {
      const response = await fetch('/collect-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          startDate,
          endDate,
          targetEmail: selectedUser === 'all' ? 'All Users' : selectedUser,
          pageToken,
          type: viewMode // 'inbox' or 'sent'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = response.statusText;

        try {
          const errData = JSON.parse(errorText);
          if (errData && errData.error) errorMessage = errData.error;
        } catch {
          // If JSON parse fails, use statusText
        }

        throw new Error(`Server Error: ${errorMessage}`);
      }

      const data = await response.json();

      if (data.success) {
        if (data.stats) setStats(data.stats);
        const rawData = data.data || [];
        let newRows = [];

        // Process "All Users" Rows
        if (!pageToken) {
          newRows = rawData.map(emp => {
            if (emp.error) return { name: emp.employee_name, inbox: 0, error: emp.error };
            // v5.49 Fix: Check for new object structure { items, meta }
            const acts = emp.activities ? (emp.activities.items || emp.activities) : [];
            const metaTotal = emp.activities?.meta?.total || 0;
            const fallbackTotal = acts.filter(a => a.analysis && a.analysis.is_inbox).length;

            return {
              name: emp.employee_name,
              inbox: Math.max(metaTotal, fallbackTotal) // Use the big number from backend
            };
          });
          setUserRows(newRows);
        }

        // Process Detailed Emails
        const newInbox = [];
        const seenIds = new Set();
        let flattenedActivities = [];

        if (rawData.length > 0) {
          if (rawData[0].activities) {
            rawData.forEach(emp => {
              // v5.52 Fix: Handle new object structure { items, meta }
              const acts = emp.activities ? (emp.activities.items || emp.activities) : [];
              if (Array.isArray(acts)) {
                flattenedActivities.push(...acts);
              }
            });
          } else {
            flattenedActivities = rawData;
          }
        }

        flattenedActivities.forEach(email => {
          if (!email || !email.id) return;
          if (seenIds.has(email.id)) return;
          seenIds.add(email.id);

          const date = new Date(email.updated_at || email.timestamp);
          const dateStr = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata'
          }).format(date);

          if (email.analysis && email.analysis.is_inbox) {
            newInbox.push({
              sort_epoch: email.sort_epoch || date.getTime(),
              date: dateStr,
              sender: email.from || "Unknown",
              subject: email.subject || (email.snippet ? email.snippet.substring(0, 50) + "..." : "No Subject"),
              replied: email.analysis.is_replied ? "Yes" : "No",
              summary: email.summary || email.snippet || ""
            });
          }
        });

        if (!pageToken) {
          setInboxList(newInbox);
        } else {
          setInboxList(prev => [...prev, ...newInbox]);
        }

        // Calculate Totals
        if (selectedUser === 'all' && newRows.length > 0) {
          // Dashboard Mode (All Users)
          setTotals({
            inbox: newRows.reduce((a, b) => a + b.inbox, 0),
          });
        } else {
          // Single User Mode (Inbox View)
          if (data.stats && data.stats.total) {
            setTotals({ inbox: data.stats.total });
          } else if (!pageToken) {
            setTotals({ inbox: newInbox.length });
          } else {
            setTotals(prev => ({ inbox: prev.inbox + newInbox.length }));
          }
        }

        const debugQ = data.meta ? data.meta.query_debug : "N/A";
        setNotification({
          type: 'success',
          title: 'Data Updated',
          message: `Fetched ${flattenedActivities.length} records successfully.`
        });

        // alert(`Data Updated!\nRecords: ${flattenedActivities.length}\nQuery: ${debugQ}`);

      } else {
        setNotification({
          type: 'error',
          title: 'Error Fetching Data',
          message: data.error || 'Unknown error occurred.'
        });
        // alert("Error: " + data.error);
      }
    } catch (error) {
      console.error(error);
      setNotification({
        type: 'error',
        title: 'Connection Failed',
        message: error.message
      });
      // alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
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
            onChange={(e) => setSelectedUser(e.target.value)}
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

        {/* View Mode Toggle */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase">Mode</label>
          <div className="flex bg-gray-200 rounded p-1 mt-1">
            <button
              onClick={() => setViewMode('inbox')}
              className={`flex-1 py-1 text-xs font-medium rounded ${viewMode === 'inbox' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}
            >
              Inbox
            </button>
            <button
              onClick={() => setViewMode('sent')}
              className={`flex-1 py-1 text-xs font-medium rounded ${viewMode === 'sent' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}
            >
              Sent
            </button>
          </div>
        </div>

        {/* Action Button */}
        <button
          onClick={() => handleCollectData(null)}
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
              {viewMode === 'sent' ? '📤 Sent Items' : '📥 Inbox'} ({totals.inbox})
            </button>
          </nav>
        </div>

        <div className="mt-auto">
          <button onClick={() => setToken(null)} className="text-sm text-gray-500 hover:text-red-500">Logout</button>
        </div>
      </aside>

      {/* MAIN CONTENT Area */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-gray-50 relative">
        {activeTab === 'dashboard' && (
          <div className="flex-1 overflow-y-auto p-8">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-800">Team Activity Report</h2>
              </div>
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-500 font-medium border-b">
                  <tr>
                    <th className="px-6 py-3">Employee</th>
                    <th className="px-6 py-3">{viewMode === 'sent' ? 'Sent' : 'Inbox'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-900">{row.name}</td>
                      <td className="px-6 py-3">{row.inbox}</td>
                    </tr>
                  ))}
                  {userRows.length === 0 && (
                    <tr><td colSpan="2" className="px-6 py-8 text-center text-gray-400">No data collected yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'inbox' && (
          <div className="flex-1 flex flex-col h-full w-full bg-white">
            {/* Table Container - Flex Grow to fill space */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm text-gray-500 font-semibold">
                  <tr>
                    <th className="p-3 border-b">Date</th>
                    <th className="p-3 border-b">{viewMode === 'sent' ? 'Recipient' : 'Sender'}</th>
                    <th className="p-3 border-b">Subject</th>
                    <th className="p-3 border-b text-center">Replied?</th>
                    <th className="p-3 border-b">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedInbox.slice((currentPage - 1) * 100, currentPage * 100).map((row, idx) => (
                    <tr key={idx} className="hover:bg-blue-50 transition-colors group">
                      <td className="p-3 text-gray-500 whitespace-nowrap border-b border-gray-50 w-32">{row.date}</td>
                      <td className="p-3 font-medium text-gray-900 border-b border-gray-50 w-48 truncate max-w-[12rem]">{row.sender}</td>
                      <td className="p-3 text-gray-600 border-b border-gray-50 max-w-xs cursor-help" title={row.summary}>
                        <span className="font-semibold text-blue-600 block truncate">{row.subject}</span>
                      </td>
                      <td className="p-3 text-center border-b border-gray-50 w-24">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${row.replied === 'Yes' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-300'}`}>
                          {row.replied}
                        </span>
                      </td>
                      <td className="p-3 text-gray-400 text-[10px] border-b border-gray-50 w-64 truncate max-w-xs">{row.summary}</td>
                    </tr>
                  ))}
                  {sortedInbox.length === 0 && !loading && (
                    <tr><td colSpan="5" className="p-10 text-center text-gray-400">No emails found for this period.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls - Stick to bottom of this panel only */}
            <div className="bg-gray-50 border-t p-2 flex justify-between items-center shrink-0 z-20">
              <button
                onClick={() => setCurrentPage(c => Math.max(1, c - 1))}
                disabled={currentPage === 1 || loading}
                className="bg-white text-gray-700 px-4 py-1.5 rounded text-xs hover:bg-gray-100 disabled:opacity-50 font-medium border shadow-sm"
              >
                ⬅ Previous
              </button>

              <div className="text-xs font-mono font-bold text-gray-600">
                Page {currentPage} | Showing {((currentPage - 1) * 100) + 1} - {Math.min(currentPage * 100, totals.inbox)} of {totals.inbox}
              </div>

              <div className="flex items-center space-x-4">
                <div className={`text-[10px] font-mono px-2 py-1 rounded border ${stats.limitReached ? 'bg-yellow-100 text-yellow-700 border-yellow-300' : 'bg-transparent text-gray-400 border-transparent'}`}>
                  <div className="text-gray-400 text-xs">
                    v5.55 (New UI) | Fetched: {stats.fetched || 0}
                  </div>
                </div>

                <button
                  onClick={() => {
                    if (sortedInbox.length > currentPage * 100) {
                      setCurrentPage(c => c + 1);
                    } else {
                      handleCollectData(stats.nextToken).then(() => {
                        setCurrentPage(c => c + 1);
                      });
                    }
                  }}
                  disabled={loading || (!stats.nextToken && sortedInbox.length <= currentPage * 100)}
                  className="bg-blue-600 text-white px-4 py-1.5 rounded text-xs hover:bg-blue-700 disabled:opacity-50 shadow-sm font-medium"
                >
                  {loading ? 'Loading...' : (sortedInbox.length > currentPage * 100 ? 'Next Page ➡' : 'Fetch Cloud ☁')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast Notification */}
        {notification && (
          <div className={`fixed bottom-4 right-4 max-w-sm w-full bg-white shadow-lg rounded-lg pointer-events-auto ring-1 ring-black ring-opacity-5 overflow-hidden transform transition-all duration-300 ease-out z-50 animate-slide-in`}>
            <div className="p-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  {notification.type === 'success' ? (
                    <div className="h-6 w-6 text-green-400">✅</div>
                  ) : (
                    <div className="h-6 w-6 text-red-400">⚠️</div>
                  )}
                </div>
                <div className="ml-3 w-0 flex-1 pt-0.5">
                  <p className="text-sm font-medium text-gray-900">{notification.title}</p>
                  <p className="mt-1 text-sm text-gray-500">{notification.message}</p>
                </div>
                <div className="ml-4 flex-shrink-0 flex">
                  <button
                    className="bg-white rounded-md inline-flex text-gray-400 hover:text-gray-500 focus:outline-none"
                    onClick={() => setNotification(null)}
                  >
                    <span className="sr-only">Close</span>
                    <span className="text-xl">&times;</span>
                  </button>
                </div>
              </div>
            </div>
            {/* Auto-dismiss progress bar (Optional, implied by useEffect) */}
            <div className={`h-1 w-full ${notification.type === 'success' ? 'bg-green-500' : 'bg-red-500'} opacity-30`}></div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
