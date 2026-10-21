/* =====================================================
   results.js - Winners page
   URL: Results.html?room=ROOMCODE      (live data from the server)
        Results.html?demo=1             (sample data to preview the design)

   Expected server response for GET {API_BASE_URL}/rooms/:code/results
   {
     "room": { "name": "Miss Campus 2026", "code": "CS-7K2QX", "date": "2026-10-21" },
     "categories": [ { "id": "prod", "name": "Production Number", "weight": 40 }, ... ],
     "candidates": [
       { "number": 4, "name": "Maria Santos", "title": "College of Education",
         "scores": { "prod": 88.2, "talent": 91.0 },   // category score 0-100 (averaged over judges)
         "final": 89.4 }                               // optional: computed here if missing
     ]
   }
   ===================================================== */
(function () {
  'use strict';

var API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api'
  : 'https://crownscore.onrender.com/api';

  var PLACES = [
    { ordinal: '1st', label: 'Queen' },
    { ordinal: '2nd', label: '1st Runner-up' },
    { ordinal: '3rd', label: '2nd Runner-up' }
  ];

  /* ---------- Score calculation ---------- */
  // Final = sum( category score x category weight / 100 ). No weights set = equal weights.
  function computeFinal(candidate, categories) {
    if (typeof candidate.final === 'number') return candidate.final;
    var useWeights = categories.length && categories.every(function (c) { return Number(c.weight) > 0; });
    var total = 0;
    categories.forEach(function (c) {
      var w = useWeights ? Number(c.weight) / 100 : 1 / categories.length;
      total += (Number(candidate.scores && candidate.scores[c.id]) || 0) * w;
    });
    return total;
  }

  function r2(n) { return Math.round(n * 100) / 100; }

  // Same final score = same rank (competition ranking)
  function rank(data) {
    var list = data.candidates.map(function (c) {
      return { c: c, final: r2(computeFinal(c, data.categories)) };
    });
    list.sort(function (a, b) { return b.final - a.final; });
    list.forEach(function (row, i) {
      row.rank = i > 0 && row.final === list[i - 1].final ? list[i - 1].rank : i + 1;
    });
    return list;
  }

  /* ---------- Demo data ---------- */
  var DEMO = {
    room: { name: 'Miss Campus 2026 (Sample)', code: 'CS-DEMO1', date: '2026-10-21' },
    categories: [
      { id: 'prod', name: 'Production Number', weight: 40 },
      { id: 'talent', name: 'Talent', weight: 30 },
      { id: 'gown', name: 'Evening Gown', weight: 30 }
    ],
    candidates: [
      { number: 1, name: 'Ana Reyes', title: 'College of Nursing', scores: { prod: 84.5, talent: 88.0, gown: 90.5 } },
      { number: 2, name: 'Bea Cruz', title: 'College of Business', scores: { prod: 90.0, talent: 85.5, gown: 87.0 } },
      { number: 3, name: 'Carla Dizon', title: 'College of Education', scores: { prod: 88.2, talent: 91.0, gown: 92.4 } },
      { number: 4, name: 'Dana Lim', title: 'College of Arts', scores: { prod: 79.0, talent: 93.5, gown: 84.0 } },
      { number: 5, name: 'Elle Tan', title: 'College of Science', scores: { prod: 86.0, talent: 82.0, gown: 89.5 } }
    ]
  };

  /* ---------- Helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(v) {
    var d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function showMessage(html) {
    var box = document.getElementById('status-msg');
    box.innerHTML = html;
    box.hidden = false;
  }

  /* ---------- Rendering ---------- */
  function render(data) {
    var ranked = rank(data);

    document.title = data.room.name + ' | Results | CrownScore';
    document.getElementById('event-name').textContent = data.room.name || 'Pageant Results';
    document.getElementById('event-meta').textContent =
      [data.room.code ? 'Room ' + data.room.code : '', fmtDate(data.room.date)].filter(Boolean).join('  \u00B7  ');

    renderPodium(ranked);
    renderAwards(data, ranked);
    renderTable(data, ranked);

    document.getElementById('results-body').hidden = false;
    wireExport(data, ranked);
  }

  function renderPodium(ranked) {
    var podium = document.getElementById('podium');
    podium.innerHTML = '';

    // Visual order: 2nd, 1st, 3rd
    [1, 0, 2].forEach(function (idx) {
      var row = ranked[idx];
      if (!row) return;

      var place = el('div', 'place place-' + (idx + 1));
      if (idx === 0) place.appendChild(el('div', 'crown', '\uD83D\uDC51'));
      place.appendChild(el('div', 'place-name', row.c.name));
      place.appendChild(el('div', 'place-title', row.c.title || ''));

      var pedestal = el('div', 'pedestal');
      pedestal.appendChild(el('div', 'rank-big', PLACES[idx].ordinal));
      pedestal.appendChild(el('div', 'award-label', PLACES[idx].label));
      pedestal.appendChild(el('div', 'score', row.final.toFixed(2)));
      pedestal.appendChild(el('div', 'award-label', 'No. ' + row.c.number));
      place.appendChild(pedestal);

      podium.appendChild(place);
    });
  }

  function renderAwards(data, ranked) {
    var grid = document.getElementById('awards');
    grid.innerHTML = '';

    data.categories.forEach(function (cat) {
      var best = ranked.slice().sort(function (a, b) {
        return (Number(b.c.scores[cat.id]) || 0) - (Number(a.c.scores[cat.id]) || 0);
      })[0];
      if (!best) return;

      var card = el('div', 'award-card');
      card.appendChild(el('div', 'award-cat', 'Best in ' + cat.name));
      card.appendChild(el('h3', null, best.c.name));

      var p = el('p');
      p.appendChild(document.createTextNode('No. ' + best.c.number + ' \u00B7 score '));
      p.appendChild(el('strong', null, r2(Number(best.c.scores[cat.id]) || 0).toFixed(2)));
      card.appendChild(p);

      grid.appendChild(card);
    });
  }

  function renderTable(data, ranked) {
    var head = document.getElementById('rank-head');
    var body = document.getElementById('rank-body');
    head.innerHTML = '';
    body.innerHTML = '';

    var tr = el('tr');
    ['Rank', 'No.'].forEach(function (h) { tr.appendChild(el('th', null, h)); });
    tr.appendChild(el('th', 'left', 'Candidate'));
    tr.appendChild(el('th', 'left', 'Representation'));
    data.categories.forEach(function (c) {
      tr.appendChild(el('th', null, c.name + (c.weight ? ' (' + c.weight + '%)' : '')));
    });
    tr.appendChild(el('th', null, 'Final'));
    head.appendChild(tr);

    ranked.forEach(function (row) {
      var r = el('tr', row.rank === 1 ? 'top-1' : '');
      r.appendChild(el('td', null, String(row.rank)));
      r.appendChild(el('td', null, String(row.c.number)));
      r.appendChild(el('td', 'left', row.c.name));
      r.appendChild(el('td', 'left title-cell', row.c.title || ''));
      data.categories.forEach(function (c) {
        r.appendChild(el('td', null, r2(Number(row.c.scores[c.id]) || 0).toFixed(2)));
      });
      r.appendChild(el('td', 'final', row.final.toFixed(2)));
      body.appendChild(r);
    });
  }

  /* ---------- Export ---------- */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(data, ranked) {
    var lines = [];
    lines.push(['CrownScore Official Tabulation Report'].map(csvCell).join(','));
    lines.push(['Event', data.room.name].map(csvCell).join(','));
    lines.push(['Room ID', data.room.code].map(csvCell).join(','));
    lines.push(['Date', fmtDate(data.room.date)].map(csvCell).join(','));
    lines.push('');

    var header = ['Rank', 'No.', 'Candidate', 'Representation'];
    data.categories.forEach(function (c) {
      header.push(c.name + (c.weight ? ' (' + c.weight + '%)' : ''));
    });
    header.push('Final Score');
    lines.push(header.map(csvCell).join(','));

    ranked.forEach(function (row) {
      var cells = [row.rank, row.c.number, row.c.name, row.c.title || ''];
      data.categories.forEach(function (c) {
        cells.push(r2(Number(row.c.scores[c.id]) || 0).toFixed(2));
      });
      cells.push(row.final.toFixed(2));
      lines.push(cells.map(csvCell).join(','));
    });

    return '\uFEFF' + lines.join('\r\n');   // BOM so Excel reads it correctly
  }

  function wireExport(data, ranked) {
    var menu = document.getElementById('export-menu');

    document.getElementById('export-csv').addEventListener('click', function () {
      var blob = new Blob([buildCsv(data, ranked)], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'CrownScore-' + (data.room.code || 'results') + '-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      menu.open = false;
    });

    document.getElementById('export-pdf').addEventListener('click', function () {
      menu.open = false;
      window.print();   // choose "Save as PDF" in the print dialog
    });

    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target)) menu.open = false;
    });
  }

  /* ---------- Load ---------- */
  function load() {
    var params = new URLSearchParams(window.location.search);

    if (params.get('demo')) {
      render(DEMO);
      return;
    }

    var code = params.get('room');
    if (!code) {
      document.getElementById('event-name').textContent = 'No room selected';
      showMessage('Open this page from your <a href="Profile.html">Profile</a> using <strong>View results</strong>. ' +
                  'Want a preview? <a href="Results.html?demo=1">See sample results</a>.');
      return;
    }

    fetch(API_BASE_URL + '/rooms/' + encodeURIComponent(code) + '/results', {
      headers: { 'ngrok-skip-browser-warning': 'true' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(render)
      .catch(function (err) {
        console.error('Results load error:', err);
        document.getElementById('event-name').textContent = 'Results unavailable';
        showMessage('We couldn\u2019t load results for room <strong></strong>. ' +
                    'Check that the server has the results route. <a href="Results.html?demo=1">See sample results</a>.');
        document.querySelector('#status-msg strong').textContent = code;
      });
  }

  // Expose the calculation for testing
  window.CrownScoreResults = { computeFinal: computeFinal, rank: rank };

  load();
})();
