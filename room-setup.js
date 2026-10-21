/* =====================================================
   room-setup.js - Room setup helpers
   Load AFTER room.js. It does NOT replace room.js; it adds:
   - auto-generated Room ID
   - weight meters (sub-criteria must total 100%) per category
   - candidate roster rows (number / name / representation)
   - validation before "Start Judging"
   ===================================================== */
(function () {
  'use strict';

  var form = document.getElementById('admin-form');
  if (!form) return;

  var cats = document.getElementById('categories-container');
  var roster = document.getElementById('contestant-container');
  var errorEl = document.getElementById('setup-error');
  var summaryEl = document.getElementById('setup-summary');
  var roomCode = document.getElementById('roomCode');

  /* ---------- 1. Room ID (automatic) ---------- */
  var ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makeRoomId() {
    var bytes = new Uint32Array(5);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var id = 'CS-';
    for (var i = 0; i < bytes.length; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length];
    return id;
  }

  roomCode.value = makeRoomId();

  var copyBtn = document.getElementById('copy-room-id');
  copyBtn.addEventListener('click', function () {
    var done = function () {
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(roomCode.value).then(done);
    } else {
      roomCode.select();
      document.execCommand('copy');
      done();
    }
  });

  /* ---------- Show / hide room password ---------- */
  var passInput = document.getElementById('roomPassword');
  var passToggle = document.getElementById('room-pass-toggle');
  passToggle.addEventListener('click', function () {
    var showing = passInput.type === 'text';
    passInput.type = showing ? 'password' : 'text';
    passToggle.textContent = showing ? 'Show' : 'Hide';
    passToggle.setAttribute('aria-pressed', String(!showing));
    passToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });

  /* ---------- 2. Categories: weight meter + category weight ---------- */
  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function fmt(n) {
    return String(Math.round(n * 100) / 100);
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function decorate(block) {
    if (block.querySelector('.weight-tools')) return;

    // Category weight (share of the final score)
    var nameGroup = block.querySelector('.form-group');
    var weightGroup = document.createElement('div');
    weightGroup.className = 'form-group category-weight-group';
    weightGroup.innerHTML =
      '<label>Category Weight (% of final score):</label>' +
      '<input type="number" class="category-weight" min="1" max="100" placeholder="e.g. 40">';
    if (nameGroup) nameGroup.after(weightGroup);

    // Meter + helper
    var tools = document.createElement('div');
    tools.className = 'weight-tools';
    tools.innerHTML =
      '<div class="meter" data-state="under" role="status">' +
        '<div class="meter-track"><div class="meter-bar"></div></div>' +
        '<span class="meter-text">Total 0 / 100%</span>' +
      '</div>' +
      '<button type="button" class="btn-link distribute">Distribute evenly</button>';
    block.appendChild(tools);
  }

  function updateMeter(block) {
    var meter = block.querySelector('.meter');
    if (!meter) return 0;

    var rows = block.querySelectorAll('.criteria-weight');
    var sum = 0;
    rows.forEach(function (r) { sum += num(r.value); });

    var state = Math.abs(sum - 100) < 0.001 ? 'exact' : (sum > 100 ? 'over' : 'under');
    var text;
    if (state === 'exact') text = 'Total 100 / 100% - perfect';
    else if (state === 'over') text = 'Total ' + fmt(sum) + ' / 100% - remove ' + fmt(sum - 100) + '%';
    else text = 'Total ' + fmt(sum) + ' / 100% - add ' + fmt(100 - sum) + '% more';

    if (meter.getAttribute('data-state') !== state) meter.setAttribute('data-state', state);
    setText(meter.querySelector('.meter-text'), text);

    var bar = meter.querySelector('.meter-bar');
    var width = Math.min(sum, 100) + '%';
    if (bar.style.width !== width) bar.style.width = width;

    if (state === 'exact') block.classList.remove('is-invalid');
    return sum;
  }

  function refreshAll() {
    cats.querySelectorAll('.category-block').forEach(function (b) {
      decorate(b);
      updateMeter(b);
    });
    refreshSummary();
  }

  // Distribute evenly
  cats.addEventListener('click', function (e) {
    var btn = e.target.closest('.distribute');
    if (!btn) return;
    var block = btn.closest('.category-block');
    var inputs = block.querySelectorAll('.criteria-weight');
    if (!inputs.length) return;
    var base = Math.floor(100 / inputs.length);
    var extra = 100 - base * inputs.length;
    inputs.forEach(function (inp, i) {
      inp.value = base + (i < extra ? 1 : 0);
    });
    updateMeter(block);
    refreshSummary();
  });

  cats.addEventListener('input', function (e) {
    var block = e.target.closest('.category-block');
    if (block) updateMeter(block);
    refreshSummary();
  });

  // Catches categories / sub-criteria rows added by room.js
  new MutationObserver(refreshAll).observe(cats, { childList: true, subtree: true });

  /* ---------- 3. Candidate roster ---------- */
  function buildRow(n) {
    var row = document.createElement('div');
    row.className = 'candidate-row';
    row.innerHTML =
      '<input type="number" class="candidate-number" min="1" value="' + n + '" required aria-label="Candidate number">' +
      '<input type="text" class="contestant-input" name="contestantName" placeholder="Full name" required aria-label="Candidate name">' +
      '<input type="text" class="candidate-title" placeholder="e.g. Department of Education" aria-label="Representation or title">' +
      '<button type="button" class="btn-remove" aria-label="Remove candidate">\u2715</button>';
    return row;
  }

  function nextNumber() {
    var max = 0;
    roster.querySelectorAll('.candidate-number').forEach(function (i) {
      max = Math.max(max, num(i.value));
    });
    return max + 1;
  }

  // Replaces the old one-box version; room.js still reads ".contestant-input" for names
  window.addContestantInput = function () {
    var row = buildRow(nextNumber());
    roster.appendChild(row);
    row.querySelector('.contestant-input').focus();
    refreshSummary();
  };

  roster.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-remove');
    if (!btn) return;
    if (roster.querySelectorAll('.candidate-row').length > 1) {
      btn.closest('.candidate-row').remove();
      refreshSummary();
    }
  });

  roster.addEventListener('input', refreshSummary);

  document.getElementById('generate-rows').addEventListener('click', function () {
    var target = Math.max(1, Math.min(100, parseInt(document.getElementById('candidateCount').value, 10) || 0));
    if (!target) return;
    var rows = roster.querySelectorAll('.candidate-row');
    for (var i = rows.length; i < target; i++) roster.appendChild(buildRow(i + 1));
    for (var j = rows.length; j > target; j--) {
      var last = roster.querySelectorAll('.candidate-row');
      last[last.length - 1].remove();
    }
    refreshSummary();
  });

  document.getElementById('numJudges').addEventListener('input', refreshSummary);

  /* ---------- Review summary ---------- */
  function categoryStatus() {
    var blocks = cats.querySelectorAll('.category-block');
    var allExact = true;
    blocks.forEach(function (b) {
      var m = b.querySelector('.meter');
      if (!m || m.getAttribute('data-state') !== 'exact') allExact = false;
    });
    return allExact;
  }

  function chip(html, cls) {
    return '<span class="sum-chip ' + (cls || '') + '">' + html + '</span>';
  }

  function refreshSummary() {
    var nCats = cats.querySelectorAll('.category-block').length;
    var nSubs = cats.querySelectorAll('.criteria-row').length;
    var nCand = roster.querySelectorAll('.candidate-row').length;
    var judges = parseInt(document.getElementById('numJudges').value, 10) || 0;
    var ok = categoryStatus();

    var html =
      chip('Categories: <strong>' + nCats + '</strong>') +
      chip('Sub-criteria: <strong>' + nSubs + '</strong>') +
      chip('Candidates: <strong>' + nCand + '</strong>') +
      chip('Judges: <strong>' + judges + '</strong>') +
      chip(ok ? 'Weights: all 100% \u2713' : 'Weights: not 100% yet', ok ? 'ok' : 'bad');

    if (summaryEl.innerHTML !== html) summaryEl.innerHTML = html;
  }

  /* ---------- Validation before Start Judging ---------- */
  function validate() {
    var problems = [];
    var firstBad = null;

    cats.querySelectorAll('.category-block').forEach(function (block, i) {
      var name = (block.querySelector('.category-name').value || '').trim() || ('Category ' + (i + 1));
      var sum = updateMeter(block);
      if (Math.abs(sum - 100) >= 0.001) {
        block.classList.add('is-invalid');
        if (!firstBad) firstBad = block;
        problems.push(name + ': sub-criteria total ' + fmt(sum) + '%, it must be exactly 100%.');
      }
    });

    // Category weights: all blank = equal weighting; otherwise must total 100
    var cw = Array.prototype.slice.call(cats.querySelectorAll('.category-weight'));
    var filled = cw.filter(function (c) { return c.value !== ''; });
    if (filled.length) {
      var total = 0;
      cw.forEach(function (c) { total += num(c.value); });
      if (filled.length !== cw.length || Math.abs(total - 100) >= 0.001) {
        problems.push('Category weights must be filled in for every category and total 100% (now ' + fmt(total) + '%).');
      }
    }

    var judges = parseInt(document.getElementById('numJudges').value, 10);
    if (!(judges >= 1 && judges <= 15)) problems.push('Number of judges must be between 1 and 15.');

    var seen = {};
    roster.querySelectorAll('.candidate-number').forEach(function (inp) {
      var v = inp.value;
      if (v && seen[v]) problems.push('Candidate number ' + v + ' is used more than once.');
      seen[v] = true;
    });

    return { problems: problems, firstBad: firstBad };
  }

  // Runs before room.js's onsubmit handler, and blocks it when data is wrong
  document.addEventListener('submit', function (e) {
    if (e.target !== form) return;
    var result = validate();
    if (result.problems.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      errorEl.innerHTML = result.problems.map(function (p) {
        var li = document.createElement('div');
        li.textContent = '\u2022 ' + p;
        return li.outerHTML;
      }).join('');
      errorEl.hidden = false;
      (result.firstBad || errorEl).scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      errorEl.hidden = true;
    }
  }, true);

  refreshAll();
})();
