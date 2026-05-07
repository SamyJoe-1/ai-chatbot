'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/db');
const path = require('path');

// Simple authentication middleware using .env credentials
const auth = (req, res, next) => {
  const adminUser = process.env.DB_MANAGER_USER || 'admin_db';
  const adminPass = process.env.DB_MANAGER_PASS || 'secret_db_pass';

  // We'll use basic auth for simplicity in this dedicated route
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Database Manager"');
    return res.status(401).send('Authentication required');
  }

  const [user, pass] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  if (user === adminUser && pass === adminPass) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Database Manager"');
  return res.status(401).send('Invalid credentials');
};

router.use(auth);

// UI Page
router.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SQLite Manager Lite</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/inter-ui@3.19.3/inter.css">
        <style>
            :root {
                --primary: #f86f23;
                --bg: #062430;
                --card: #0a2e3d;
                --text: #e0e6ed;
                --border: #1a4a5e;
            }
            body {
                font-family: 'Inter', sans-serif;
                background: var(--bg);
                color: var(--text);
                margin: 0;
                display: flex;
                height: 100vh;
            }
            #sidebar {
                width: 250px;
                background: var(--card);
                border-right: 1px solid var(--border);
                overflow-y: auto;
                padding: 20px;
            }
            #content {
                flex: 1;
                overflow-y: auto;
                padding: 30px;
            }
            h2 { color: var(--primary); margin-top: 0; }
            .table-link {
                display: block;
                padding: 10px;
                color: var(--text);
                text-decoration: none;
                border-radius: 6px;
                margin-bottom: 5px;
                transition: 0.2s;
            }
            .table-link:hover { background: var(--border); }
            .table-link.active { background: var(--primary); color: white; }
            
            table {
                width: 100%;
                border-collapse: collapse;
                background: var(--card);
                border-radius: 8px;
                overflow: hidden;
            }
            th, td {
                padding: 12px 15px;
                text-align: left;
                border-bottom: 1px solid var(--border);
                font-size: 14px;
            }
            th { background: rgba(248, 111, 35, 0.1); color: var(--primary); font-weight: 600; }
            tr:hover { background: rgba(255, 255, 255, 0.03); }
            
            .actions { display: flex; gap: 10px; }
            button {
                background: var(--primary);
                color: white;
                border: none;
                padding: 8px 15px;
                border-radius: 5px;
                cursor: pointer;
                font-weight: 600;
            }
            button.danger { background: #ff4d4d; }
            button:hover { opacity: 0.9; }
            
            #loading { display: none; position: fixed; top: 10px; right: 10px; background: var(--primary); padding: 5px 15px; border-radius: 20px; }
        </style>
    </head>
    <body>
        <div id="sidebar">
            <h2>Tables</h2>
            <div id="table-list">Loading...</div>
        </div>
        <div id="content">
            <div id="view-header" style="display:flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 id="current-table">Select a table</h2>
                <div class="actions">
                    <button id="add-btn" style="display:none;">+ Add Row</button>
                </div>
            </div>
            <div id="data-container">
                <p>Select a table from the sidebar to view data.</p>
            </div>
        </div>
        <div id="loading">Processing...</div>

        <script>
            const listContainer = document.getElementById('table-list');
            const dataContainer = document.getElementById('data-container');
            const tableTitle = document.getElementById('current-table');
            const loading = document.getElementById('loading');
            const addBtn = document.getElementById('add-btn');

            async function api(path, options = {}) {
                loading.style.display = 'block';
                try {
                    const res = await fetch(\`/dashboard/db\${path}\`, {
                        method: options.method || 'GET',
                        headers: { 'Content-Type': 'application/json' },
                        body: options.body ? JSON.stringify(options.body) : undefined
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'API Error');
                    return data;
                } catch (e) {
                    alert(e.message);
                } finally {
                    loading.style.display = 'none';
                }
            }

            async function loadTables() {
                const tables = await api('/api/tables');
                if (!tables) return;
                listContainer.innerHTML = tables.map(t => 
                    \`<a href="#" class="table-link" onclick="loadTable('\${t.name}')">\${t.name}</a>\`
                ).join('');
            }

            async function loadTable(name) {
                document.querySelectorAll('.table-link').forEach(l => l.classList.remove('active'));
                event.target.classList.add('active');
                
                tableTitle.innerText = name;
                addBtn.style.display = 'block';
                addBtn.onclick = () => addRow(name);

                const data = await api(\`/api/table/\${name}\`);
                if (!data) return;

                const columns = data.columns;
                const rows = data.rows;

                let html = '<table><thead><tr>';
                columns.forEach(c => html += \`<th>\${c.name}</th>\`);
                html += '<th>Actions</th></tr></thead><tbody>';

                rows.forEach(row => {
                    html += '<tr>';
                    columns.forEach(c => html += \`<td>\${row[c.name] === null ? '<i style="color:#666">null</i>' : row[c.name]}</td>\`);
                    html += \`
                        <td class="actions">
                            <button onclick="editRow('\${name}', \${JSON.stringify(row).replace(/"/g, '&quot;')})">Edit</button>
                            <button class="danger" onclick="deleteRow('\${name}', \${row.id || row.rowid})">Delete</button>
                        </td>
                    \`;
                    html += '</tr>';
                });

                html += '</tbody></table>';
                dataContainer.innerHTML = html;
            }

            async function deleteRow(table, id) {
                if (!confirm('Are you sure?')) return;
                await api(\`/api/table/\${table}/delete\`, { method: 'POST', body: { id } });
                loadTable(table);
            }

            function editRow(table, data) {
                const updated = {};
                for (let key in data) {
                    const val = prompt(\`Edit \${key}:\`, data[key]);
                    if (val === null) return;
                    updated[key] = val;
                }
                saveRow(table, updated);
            }

            function addRow(table) {
                // Simplified: ask for columns based on current table info
                alert('This is a lite version. Use Edit as a template or see source.');
            }

            async function saveRow(table, data) {
                await api(\`/api/table/\${table}/save\`, { method: 'POST', body: data });
                loadTable(table);
            }

            loadTables();
        </script>
    </body>
    </html>
  `);
});

// API Endpoints
router.get('/api/tables', (req, res) => {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    res.json(tables);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/table/:name', (req, res) => {
  try {
    const columns = db.prepare(`PRAGMA table_info(\`${req.params.name}\`)`).all();
    const rows = db.prepare(`SELECT rowid as rowid, * FROM \`${req.params.name}\` LIMIT 500`).all();
    res.json({ columns, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/table/:name/delete', (req, res) => {
  try {
    const { id } = req.body;
    // Try to delete by id or rowid
    db.prepare(`DELETE FROM \`${req.params.name}\` WHERE id = ? OR rowid = ?`).run(id, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/table/:name/save', (req, res) => {
  try {
    const data = req.body;
    const columns = Object.keys(data).filter(c => c !== 'rowid');
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => data[c]);
    
    if (data.id || data.rowid) {
        const id = data.id || data.rowid;
        const setClause = columns.map(c => `\`${c}\` = ?`).join(', ');
        db.prepare(`UPDATE \`${req.params.name}\` SET ${setClause} WHERE id = ? OR rowid = ?`).run(...values, id, id);
    } else {
        db.prepare(`INSERT INTO \`${req.params.name}\` (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
