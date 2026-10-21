/* CrownScore stage background (stage.js)
   Adds the spotlight/sparkle background to any page.
   Include at the end of <body>:  <script src="stage.js"></script> */
(function () {
  if (document.querySelector('.stage-bg')) return; // already on the page

  var stage = document.createElement('div');
  stage.className = 'stage-bg';
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML =
    '<div class="beam beam-1"></div>' +
    '<div class="beam beam-2"></div>' +
    '<div class="beam beam-3"></div>' +
    '<div class="sparkles"></div>' +
    '<div class="stage-floor"></div>';
  document.body.prepend(stage);

  // Gold sparkles drifting across the stage
  var box = stage.querySelector('.sparkles');
  for (var i = 0; i < 36; i++) {
    var s = document.createElement('span');
    s.className = 'sparkle';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--s', (6 + Math.random() * 12).toFixed(1) + 'px');
    s.style.setProperty('--d', (4 + Math.random() * 5).toFixed(1) + 's');
    s.style.setProperty('--delay', (Math.random() * 6).toFixed(1) + 's');
    box.appendChild(s);
  }
})();
