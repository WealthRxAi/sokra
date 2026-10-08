/* Sokra marketing front door.
 *
 * The hero is one continuous 15 second take. The visitor's scroll is what
 * plays it, so the paper flattens at the speed of their own hand. No library:
 * a sticky stage, a scroll ratio, and an eased seek on one <video>.
 *
 * Everything degrades. No JS, slow connection, reduced motion or a refused
 * decode all leave the exact first frame on screen as a still, and every word
 * on the page is in the HTML either way.
 */
(function () {
  "use strict";

  var band = document.getElementById("band");
  var film = document.getElementById("film");
  var bar = document.getElementById("bar");

  function onScrollBar() {
    if (!bar) return;
    var d = document.documentElement;
    var max = d.scrollHeight - window.innerHeight;
    bar.style.transform = "scaleX(" + (max > 0 ? d.scrollTop / max : 0) + ")";
  }
  window.addEventListener("scroll", onScrollBar, { passive: true });
  onScrollBar();

  if (!band || !film) return;

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var small = window.matchMedia("(max-width: 860px)").matches;
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  var thrifty = !!(conn && (conn.saveData || /^([23]g|slow-2g)$/.test(conn.effectiveType || "")));

  // The poster is the exact first frame of the encoded clip, so leaving it in
  // place is a complete, correct hero rather than a fallback that looks broken.
  if (reduce || thrifty) return;

  var src = small ? film.getAttribute("data-mobile") : film.getAttribute("data-desktop");
  if (!src) return;

  // This is the homepage now, and someone holding a bill should not wait behind
  // 11MB of film for the upload card to become usable. The poster is already the
  // exact first frame, so hold the fetch until the page has finished loading and
  // had a moment of quiet. Nothing on screen changes when it arrives.
  if (document.readyState !== "complete") {
    window.addEventListener("load", function () { setTimeout(begin, 700); }, { once: true });
    return;
  }
  setTimeout(begin, 200);
  function begin() {
  // The markup carries preload="none" so a visitor without JS downloads
  // nothing. Now that we are driving the playhead, ask for the media: with
  // preload="none" an assignment to src alone fetches nothing, so load() is
  // what actually starts it and lets loadedmetadata fire.
  film.preload = "auto";
  film.src = src;
  film.load();

  // A Blob source makes seeking instant. It needs CORS, which the media host
  // may not send, so it is an upgrade attempt and never a requirement.
  var objectUrl = null;
  try {
    fetch(src, { mode: "cors" })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) {
        if (!b) return;
        objectUrl = URL.createObjectURL(b);
        var at = film.currentTime;
        film.src = objectUrl;
        film.load();
        film.addEventListener("loadedmetadata", function once() {
          film.removeEventListener("loadedmetadata", once);
          try { film.currentTime = at; } catch (e) { /* seek lands next frame */ }
        });
      })
      .catch(function () { /* ranged requests on the direct src are fine */ });
  } catch (e) { /* no fetch, no upgrade */ }

  var duration = 0;
  var current = 0;
  var seeking = false;
  var raf = 0;

  film.addEventListener("loadedmetadata", function () {
    duration = film.duration && isFinite(film.duration) ? film.duration : 15;
  });
  film.addEventListener("seeked", function () { seeking = false; });
  film.addEventListener("error", function () {
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    film.style.display = "none"; // the poster plate underneath stays
  });

  // iOS will not decode until the page has seen a gesture.
  function prime() {
    var p = film.play();
    if (p && p.then) p.then(function () { film.pause(); }).catch(function () {});
    else film.pause();
  }
  window.addEventListener("touchstart", prime, { once: true, passive: true });
  window.addEventListener("pointerdown", prime, { once: true, passive: true });

  function ratio() {
    var travel = band.offsetHeight - window.innerHeight;
    if (travel <= 0) return 0;
    var past = -band.getBoundingClientRect().top;
    return Math.min(1, Math.max(0, past / travel));
  }

  function tick() {
    raf = window.requestAnimationFrame(tick);
    if (!duration) {
      if (film.duration && isFinite(film.duration)) duration = film.duration;
      return;
    }
    var target = ratio() * (duration - 0.05);
    current += (target - current) * 0.17;
    if (Math.abs(target - current) < 0.004) current = target;
    if (!seeking && Math.abs(film.currentTime - current) > 0.02) {
      seeking = true;
      try { film.currentTime = current; } catch (e) { seeking = false; }
    }
  }

    raf = window.requestAnimationFrame(tick);
  }

  window.addEventListener("pagehide", function () {
    if (raf) window.cancelAnimationFrame(raf);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
})();
