/* ==========================================================================
   room.js - Pageant Room Setup, Kahoot-Style Judging Flow & Live Leaderboard
   ========================================================================== */

const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api'
  : 'https://crownscore.onrender.com/api';

// --- GLOBAL STATE ---
let currentRoom = {
  id: null,
  code: '',
  name: '',
  password: '',
  numJudges: 0,
  categories: [],   // Array of { id, name, weight, criteria: [{ id, name, weight }] }
  contestants: [],  // Array of { id, number, name, representation }
  scores: [],       // Raw score rows from API
  activeJudgeNumber: null
};

let pollInterval = null;

// --- KAHOOT-STYLE WIZARD STATE ---
let wizardCatIdx = 0;
let wizardCandIdx = 0;
let wizardScoreDrafts = {}; // Format: { "contestantId_criteriaId": value }
let isScoresLocked = false;

// Initialize Logout Guard on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initLogoutModalGuard();
});

// --- USER HELPER ---
function getLoggedInUser() {
  try {
    const user = JSON.parse(localStorage.getItem('currentUser'));
    return user || null;
  } catch (e) {
    return null;
  }
}

// --- LOGOUT CONFIRMATION MODAL ---
function initLogoutModalGuard() {
  const modal = document.getElementById('logout-modal');
  const cancelBtn = document.getElementById('btn-cancel-logout');
  const confirmBtn = document.getElementById('btn-confirm-logout');

  document.querySelectorAll('.btn-logout').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (modal) modal.hidden = false;
    });
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (modal) modal.hidden = true;
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      localStorage.removeItem('currentUser');
      window.location.href = 'index.html';
    });
  }
}

// --- NAVIGATION & VIEWS ---
function hideAllViews() {
  document.getElementById('role-selection-view').classList.add('hidden');
  document.getElementById('admin-view').classList.add('hidden');
  document.getElementById('admin-dashboard-view').classList.add('hidden');
  document.getElementById('judge-login-view').classList.add('hidden');
  document.getElementById('judge-portal-view').classList.add('hidden');
}

function resetToRoleSelection() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  hideAllViews();
  document.getElementById('role-selection-view').classList.remove('hidden');
}

function showAdminFlow() {
  const user = getLoggedInUser();
  if (!user) {
    alert('Please log in first.');
    window.location.href = 'index.html';
    return;
  }
  hideAllViews();
  document.getElementById('admin-view').classList.remove('hidden');
}

function showJudgeFlow() {
  const user = getLoggedInUser();
  if (!user) {
    alert('Please log in first.');
    window.location.href = 'index.html';
    return;
  }
  hideAllViews();
  document.getElementById('judge-login-view').classList.remove('hidden');
}

// --- DYNAMIC FORM INPUTS (ADMIN SETUP) ---
function addCategoryInput() {
  const container = document.getElementById('categories-container');
  const catBlock = document.createElement('div');
  catBlock.className = 'category-block scoring-card';
  catBlock.innerHTML = `
    <div class="form-group">
      <label class="category-label">Category Name:</label>
      <input type="text" class="category-name" placeholder="e.g. EVENING GOWN COMPETITION" required>
    </div>
    
    <label class="sub-criteria-title">Sub-Criteria Breakdown:</label>
    <div class="sub-criteria-container">
      <div class="criteria-row">
        <input type="text" class="criteria-name" placeholder="e.g. Elegance & Carriage" required>
        <input type="number" class="criteria-weight" placeholder="Weight (%)" min="1" max="100" required>
      </div>
    </div>
    <button type="button" class="btn-secondary" onclick="addSubCriteriaInput(this)">+ Add Sub-Criteria</button>
  `;
  container.appendChild(catBlock);
}

function addSubCriteriaInput(btn) {
  const container = btn.previousElementSibling;
  const row = document.createElement('div');
  row.className = 'criteria-row';
  row.innerHTML = `
    <input type="text" class="criteria-name" placeholder="e.g. Stage Presence" required>
    <input type="number" class="criteria-weight" placeholder="Weight (%)" min="1" max="100" required>
  `;
  container.appendChild(row);
}

// Fallback if room-setup.js is not present
if (typeof window.addContestantInput !== 'function') {
  window.addContestantInput = function() {
    const container = document.getElementById('contestant-container');
    const count = container.querySelectorAll('.candidate-row, .form-group').length + 1;
    const wrapper = document.createElement('div');
    wrapper.className = 'candidate-row';
    wrapper.innerHTML = `
      <input type="number" class="candidate-number" min="1" value="${count}" required aria-label="Candidate number">
      <input type="text" class="contestant-input" name="contestantName" placeholder="Full name" required aria-label="Candidate name">
      <input type="text" class="candidate-title" placeholder="e.g. Department of Education" aria-label="Representation or title">
      <button type="button" class="btn-remove" onclick="this.parentElement.remove()">✕</button>
    `;
    container.appendChild(wrapper);
  };
}

// --- ADMIN CREATES ROOM ---
async function handleAdminSubmit(e) {
  e.preventDefault();

  const user = getLoggedInUser();
  if (!user || !user.id) {
    alert('Session expired. Please log in again.');
    window.location.href = 'index.html';
    return;
  }

  const roomName = document.getElementById('roomName').value.trim();
  const roomCode = document.getElementById('roomCode').value.trim().toUpperCase();
  const roomPassword = document.getElementById('roomPassword').value.trim();
  const numJudges = parseInt(document.getElementById('numJudges').value, 10);

  const categoryBlocks = document.querySelectorAll('.category-block');
  let parsedCategories = [];

  for (let block of categoryBlocks) {
    const catNameInput = block.querySelector('.category-name');
    if (!catNameInput) continue;
    const catName = catNameInput.value.trim();
    if (!catName) continue;

    const catWeightInput = block.querySelector('.category-weight');
    const catWeight = catWeightInput ? parseFloat(catWeightInput.value) || null : null;

    const critNames = block.querySelectorAll('.criteria-name');
    const critWeights = block.querySelectorAll('.criteria-weight');
    let subCriteria = [];

    for (let i = 0; i < critNames.length; i++) {
      const name = critNames[i].value.trim();
      const weight = parseFloat(critWeights[i].value) || 0;
      if (name) {
        subCriteria.push({ name, weight });
      }
    }

    parsedCategories.push({ name: catName, weight: catWeight, criteria: subCriteria });
  }

  if (parsedCategories.length === 0) {
    alert("Please add at least one category with sub-criteria.");
    return;
  }

  const candidateRows = document.querySelectorAll('#contestant-container .candidate-row');
  let parsedContestants = [];

  candidateRows.forEach((row, idx) => {
    const numInput = row.querySelector('.candidate-number');
    const nameInput = row.querySelector('.contestant-input');
    const titleInput = row.querySelector('.candidate-title');

    const number = numInput ? parseInt(numInput.value, 10) : idx + 1;
    const name = nameInput ? nameInput.value.trim() : '';
    const representation = titleInput ? titleInput.value.trim() : '';

    if (name) {
      parsedContestants.push({ number, name, representation });
    }
  });

  if (parsedContestants.length === 0) {
    alert("Please add at least one candidate.");
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/rooms/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: roomCode,
        roomName: roomName,
        password: roomPassword,
        numJudges: numJudges,
        categories: parsedCategories,
        contestants: parsedContestants,
        userId: user.id
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to create room.');
    }

    currentRoom.id = result.roomId;
    currentRoom.code = result.code || roomCode;
    currentRoom.name = roomName;
    currentRoom.password = roomPassword;
    currentRoom.numJudges = numJudges;
    currentRoom.categories = result.categories;
    currentRoom.contestants = result.contestants;

    startLiveScorePolling();
    renderAdminDashboard();

    hideAllViews();
    document.getElementById('admin-dashboard-view').classList.remove('hidden');

  } catch (err) {
    console.error("Admin setup error:", err);
    alert("Error setting up room: " + err.message);
  }
}

// --- LIVE SCORE POLLING ---
function startLiveScorePolling() {
  fetchLiveScores();
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(fetchLiveScores, 3000);
}

async function fetchLiveScores() {
  const user = getLoggedInUser();
  if (!user || !currentRoom.id) return;

  try {
    const res = await fetch(`${API_BASE_URL}/rooms/${currentRoom.id}/scores?userId=${user.id}`);
    if (res.ok) {
      const data = await res.json();
      currentRoom.scores = data;
      renderAdminDashboard();
    }
  } catch (err) {
    console.error("Error fetching live scores:", err);
  }
}

// --- RENDER ADMIN DASHBOARD ---
function renderAdminDashboard() {
  const contestantsEl = document.getElementById('stat-contestants');
  const judgesEl = document.getElementById('stat-judges');
  if (contestantsEl) contestantsEl.textContent = currentRoom.contestants.length;
  if (judgesEl) judgesEl.textContent = currentRoom.numJudges;

  const judgesList = document.getElementById('judges-status-list');
  if (judgesList) {
    judgesList.innerHTML = '';
    const submittedJudges = new Set(
      currentRoom.scores
        .filter(s => s.is_final === 1 || s.is_final === true)
        .map(s => s.judge_number)
    );

    for (let j = 1; j <= currentRoom.numJudges; j++) {
      const isSubmitted = submittedJudges.has(j);
      const badge = document.createElement('div');
      badge.className = `judge-status-badge ${isSubmitted ? 'submitted' : 'pending'}`;
      badge.innerHTML = `
        <span class="judge-name">Judge #${j}</span>: 
        <span class="badge-status">${isSubmitted ? '✅ Submitted' : '⏳ Scoring...'}</span>
      `;
      judgesList.appendChild(badge);
    }
  }

  const tableHead = document.getElementById('scores-table-head');
  if (tableHead) {
    let headHTML = `<tr><th>Rank</th><th>Candidate</th>`;
    for (let j = 1; j <= currentRoom.numJudges; j++) {
      headHTML += `<th>Judge #${j}</th>`;
    }
    headHTML += `<th>Final Weighted Score</th></tr>`;
    tableHead.innerHTML = headHTML;
  }

  renderLeaderboardRows();
}

function renderLeaderboardRows() {
  const tableBody = document.getElementById('scores-table-body');
  if (!tableBody) return;
  tableBody.innerHTML = '';

  let allCriteria = [];
  currentRoom.categories.forEach(cat => {
    if (cat.criteria) {
      cat.criteria.forEach(crit => allCriteria.push({ ...crit, catId: cat.id, catWeight: cat.weight || 100 }));
    }
  });

  let contestantResults = currentRoom.contestants.map(contestant => {
    let judgeTotals = [];
    let grandTotal = 0;
    let submittedJudgeCount = 0;

    for (let j = 1; j <= currentRoom.numJudges; j++) {
      const judgeScores = currentRoom.scores.filter(
        s => s.judge_number === j && s.contestant_id === contestant.id
      );

      if (judgeScores.length > 0) {
        let judgeTotal = 0;
        judgeScores.forEach(s => {
          const crit = allCriteria.find(c => c.id === s.criteria_id);
          if (crit) {
            judgeTotal += (parseFloat(s.score || s.score_value) * (parseFloat(crit.weight) / 100));
          }
        });
        judgeTotals.push(judgeTotal.toFixed(2));
        grandTotal += judgeTotal;
        submittedJudgeCount++;
      } else {
        judgeTotals.push('—');
      }
    }

    const finalAverage = submittedJudgeCount > 0 ? (grandTotal / submittedJudgeCount).toFixed(2) : '0.00';

    return {
      name: contestant.name,
      number: contestant.number || contestant.contestant_number,
      title: contestant.representation,
      judgeTotals,
      finalAverage: parseFloat(finalAverage)
    };
  });

  contestantResults.sort((a, b) => b.finalAverage - a.finalAverage);

  contestantResults.forEach((res, rankIdx) => {
    const tr = document.createElement('tr');
    if (rankIdx === 0 && res.finalAverage > 0) tr.className = 'rank-1';

    let judgeCells = res.judgeTotals.map(s => `<td>${s}</td>`).join('');
    
    tr.innerHTML = `
      <td><span class="${rankIdx === 0 && res.finalAverage > 0 ? 'crown-rank' : 'rank-num'}">${rankIdx === 0 && res.finalAverage > 0 ? '👑 1' : rankIdx + 1}</span></td>
      <td><strong>#${res.number} — ${res.name}</strong> ${res.title ? `<br><small style="color:#aaa;">${res.title}</small>` : ''}</td>
      ${judgeCells}
      <td class="score-total">${res.finalAverage}%</td>
    `;
    tableBody.appendChild(tr);
  });
}

// --- JUDGE AUTHENTICATION ---
async function handleJudgeLogin(e) {
  e.preventDefault();

  const user = getLoggedInUser();
  if (!user || !user.id) {
    alert('Session expired. Please log in again.');
    window.location.href = 'index.html';
    return;
  }

  const codeInput = document.getElementById('inputRoomCode').value.trim().toUpperCase();
  const passwordInput = document.getElementById('inputRoomPassword').value.trim();
  const selectedJudge = parseInt(document.getElementById('judgeSelect').value, 10);

  try {
    const res = await fetch(`${API_BASE_URL}/rooms/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: codeInput,
        password: passwordInput,
        userId: user.id,
        judgeNumber: selectedJudge
      })
    });

    const room = await res.json();

    if (!res.ok) {
      alert(room.message || "Invalid Room ID or Password.");
      return;
    }

    currentRoom.id = room.id;
    currentRoom.code = room.code;
    currentRoom.numJudges = room.num_judges;
    currentRoom.categories = room.categories;
    currentRoom.contestants = room.contestants;
    currentRoom.activeJudgeNumber = room.judgeNumber || selectedJudge;

    await initKahootStylePortal();
    hideAllViews();
    document.getElementById('judge-portal-view').classList.remove('hidden');

  } catch (err) {
    console.error("Judge login error:", err);
    alert("Login failed: " + err.message);
  }
}

// --- KAHOOT-STYLE SEQUENTIAL PORTAL LOGIC ---
async function initKahootStylePortal() {
  const user = getLoggedInUser();
  const judgeNum = currentRoom.activeJudgeNumber;

  document.getElementById('judge-portal-title').textContent = `Judge #${judgeNum} Scoring Portal`;

  wizardCatIdx = 0;
  wizardCandIdx = 0;
  wizardScoreDrafts = {};
  isScoresLocked = false;

  try {
    const res = await fetch(`${API_BASE_URL}/rooms/${currentRoom.id}/scores/judge/${user.id}`);
    if (res.ok) {
      const existingScores = await res.json();
      existingScores.forEach(s => {
        wizardScoreDrafts[`${s.contestant_id}_${s.criteria_id}`] = s.score;
        if (s.is_final) isScoresLocked = true;
      });
    }
  } catch (err) {
    console.error("Error fetching existing judge scores:", err);
  }

  const lockBanner = document.getElementById('judge-locked-banner');
  if (lockBanner) lockBanner.hidden = !isScoresLocked;

  document.getElementById('judging-summary-card').hidden = true;
  document.getElementById('judging-active-card').hidden = false;
  document.getElementById('wizard-progress-bar').hidden = false;

  renderWizardStep();
}

function saveActiveCardInputs() {
  const currentCat = currentRoom.categories[wizardCatIdx];
  const currentCand = currentRoom.contestants[wizardCandIdx];
  if (!currentCat || !currentCand) return;

  currentCat.criteria.forEach(crit => {
    const input = document.getElementById(`wizard-crit-${crit.id}`);
    if (input) {
      const val = parseFloat(input.value);
      wizardScoreDrafts[`${currentCand.id}_${crit.id}`] = isNaN(val) ? '' : val;
    }
  });
}

function renderWizardStep() {
  const cats = currentRoom.categories;
  const cands = currentRoom.contestants;

  const currentCat = cats[wizardCatIdx];
  const currentCand = cands[wizardCandIdx];

  // Progress Bar updates
  const totalSteps = cats.length * cands.length;
  const currentStepNum = (wizardCatIdx * cands.length) + wizardCandIdx + 1;
  const progressPct = (currentStepNum / totalSteps) * 100;

  document.getElementById('wizard-progress-fill').style.width = `${progressPct}%`;
  document.getElementById('cat-progress-label').textContent = `Category ${wizardCatIdx + 1} of ${cats.length}: ${currentCat.name}`;
  document.getElementById('cand-progress-label').textContent = `Candidate ${wizardCandIdx + 1} of ${cands.length}`;

  // Active Card Information
  document.getElementById('active-cat-badge').textContent = currentCat.name;
  document.getElementById('active-cand-title').textContent = `Candidate #${currentCand.number || currentCand.contestant_number} — ${currentCand.name}`;
  document.getElementById('active-cand-rep').textContent = currentCand.representation || '';

  // Render Sub-Criteria Fields
  const container = document.getElementById('active-criteria-fields');
  container.innerHTML = '';

  currentCat.criteria.forEach(crit => {
    const key = `${currentCand.id}_${crit.id}`;
    const savedVal = wizardScoreDrafts[key] !== undefined ? wizardScoreDrafts[key] : '';

    const field = document.createElement('div');
    field.className = 'form-group';
    field.style.marginBottom = '12px';
    field.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <label style="color:#fff; font-weight:600;">${crit.name}</label>
        <span style="color:#d4af37; font-size:0.8rem; background:#222; padding:2px 6px; border-radius:4px;">${crit.weight}%</span>
      </div>
      <input type="number" id="wizard-crit-${crit.id}" class="score-input" min="0" max="100" step="0.1" 
             placeholder="Enter score 0-100" value="${savedVal}" ${isScoresLocked ? 'disabled' : ''} required>
    `;
    container.appendChild(field);
  });

  // Controls
  const prevBtn = document.getElementById('btn-wizard-prev');
  if (prevBtn) prevBtn.disabled = (wizardCatIdx === 0 && wizardCandIdx === 0);
}

function wizardNextCandidate() {
  saveActiveCardInputs();

  const cats = currentRoom.categories;
  const cands = currentRoom.contestants;

  if (wizardCandIdx < cands.length - 1) {
    wizardCandIdx++;
    renderWizardStep();
  } else if (wizardCatIdx < cats.length - 1) {
    wizardCatIdx++;
    wizardCandIdx = 0; // Reset to candidate #1 for next category
    renderWizardStep();
  } else {
    // Show summary overview table when all categories & candidates are complete
    renderWizardSummaryTable();
  }
}

function wizardPrevCandidate() {
  saveActiveCardInputs();

  const cands = currentRoom.contestants;

  if (wizardCandIdx > 0) {
    wizardCandIdx--;
    renderWizardStep();
  } else if (wizardCatIdx > 0) {
    wizardCatIdx--;
    wizardCandIdx = cands.length - 1; // Go to last candidate of previous category
    renderWizardStep();
  }
}

function renderWizardSummaryTable() {
  document.getElementById('judging-active-card').hidden = true;
  document.getElementById('wizard-progress-bar').hidden = true;
  const summaryCard = document.getElementById('judging-summary-card');
  summaryCard.hidden = false;

  let html = `<table class="results-table" style="width:100%; border-collapse:collapse;">
    <thead>
      <tr>
        <th>Candidate</th>
        ${currentRoom.categories.map(c => `<th>${c.name}</th>`).join('')}
      </tr>
    </thead>
    <tbody>`;

  currentRoom.contestants.forEach(cand => {
    html += `<tr>
      <td><strong>#${cand.number || cand.contestant_number} ${cand.name}</strong></td>`;
    
    currentRoom.categories.forEach(cat => {
      let catWeightedTotal = 0;
      cat.criteria.forEach(crit => {
        const score = parseFloat(wizardScoreDrafts[`${cand.id}_${crit.id}`]) || 0;
        catWeightedTotal += score * (crit.weight / 100);
      });
      html += `<td style="text-align:center;">${catWeightedTotal.toFixed(2)}</td>`;
    });
    html += `</tr>`;
  });

  html += `</tbody></table>`;
  document.getElementById('summary-table-container').innerHTML = html;
}

function returnToWizardEditing() {
  document.getElementById('judging-summary-card').hidden = true;
  document.getElementById('judging-active-card').hidden = false;
  document.getElementById('wizard-progress-bar').hidden = false;
  renderWizardStep();
}

// --- SUBMIT JUDGE SCORES ---
async function handleJudgeScoreSubmit(e, isFinal) {
  if (e) e.preventDefault();
  saveActiveCardInputs();

  const user = getLoggedInUser();
  if (!user || !user.id) {
    alert('Session expired. Please log in again.');
    return;
  }

  const candidateGrouped = {};

  currentRoom.contestants.forEach(cand => {
    candidateGrouped[cand.id] = [];
    currentRoom.categories.forEach(cat => {
      cat.criteria.forEach(crit => {
        const key = `${cand.id}_${crit.id}`;
        const scoreVal = parseFloat(wizardScoreDrafts[key]) || 0;
        candidateGrouped[cand.id].push({
          criteriaId: parseInt(crit.id, 10),
          score: scoreVal
        });
      });
    });
  });

  try {
    for (const contestantId in candidateGrouped) {
      const res = await fetch(`${API_BASE_URL}/scores/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: currentRoom.id,
          userId: user.id,
          contestantId: parseInt(contestantId, 10),
          scores: candidateGrouped[contestantId],
          final: isFinal
        })
      });

      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.message || "Failed to submit scores.");
      }
    }

    alert(isFinal ? "Official scores submitted and locked!" : "Draft scores saved successfully.");
    if (isFinal) resetToRoleSelection();

  } catch (err) {
    console.error("Score submission error:", err);
    alert("Submission error: " + err.message);
  }
}

function exportResults() {
  alert("Exporting official scoring results...");
}