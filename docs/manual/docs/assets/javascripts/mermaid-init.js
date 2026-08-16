// Render the manual's diagrams from the copy of Mermaid shipped beside them.
//
// Material for MkDocs renders diagrams too, but it fetches Mermaid from
// unpkg.com when the page loads. The manual is served from inside the ERP, so
// that request fails twice over: the app's Content-Security-Policy allows no
// third-party scripts, and an office PC running this system offline has no
// route to unpkg at all. Either way the reader gets the diagram's source code
// as a wall of text.
//
// So the fences are emitted with class `mermaid-diagram` rather than `mermaid`
// — Material only claims the latter, so it leaves these alone — and this file
// draws them from the local bundle. Change the class in mkdocs.yml and Material
// takes over again, silently, along with the CDN request.
(function () {
  function draw() {
    if (!window.mermaid) return;

    var dark = document.body.getAttribute('data-md-color-scheme') === 'slate';
    window.mermaid.initialize({
      // The diagrams are compiled from Markdown in this repository, never from
      // anything a reader supplies, so they are trusted input by construction.
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      flowchart: { htmlLabels: true, curve: 'basis' },
    });

    var blocks = document.querySelectorAll('.mermaid-diagram');
    if (!blocks.length) return;

    // superfences wraps the source in <pre class="mermaid-diagram"><code>.
    // Mermaid wants the definition as the element's own text, so unwrap first,
    // and only once — this runs again on a theme change.
    blocks.forEach(function (el) {
      if (el.dataset.mermaidSource === undefined) {
        el.dataset.mermaidSource = el.textContent.trim();
      }
      el.removeAttribute('data-processed');
      el.textContent = el.dataset.mermaidSource;
    });

    window.mermaid.run({ nodes: blocks }).catch(function () {
      // A diagram that will not parse must not take the page's other scripts
      // down with it. The reader still gets the whole page; one figure is
      // missing.
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', draw);
  } else {
    draw();
  }

  // Redraw on the light/dark toggle, otherwise a dark page keeps diagrams with
  // black text on a black background.
  var observer = new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.attributeName === 'data-md-color-scheme') draw();
    });
  });
  observer.observe(document.body, { attributes: true });
})();
