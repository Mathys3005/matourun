/* Applies the saved theme before the app renders (no flash). External file: the CSP forbids inline scripts. */
(function () {
  var colors = { violet: "#160e24", ocean: "#0b1626", foret: "#0e1a14", braise: "#1c0f0d", clair: "#1f1533" };
  try {
    var t = localStorage.getItem("mr_theme");
    if (t && colors[t] && t !== "violet") document.documentElement.setAttribute("data-theme", t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && t && colors[t]) meta.setAttribute("content", colors[t]);
  } catch (e) {
    /* storage unavailable: default theme */
  }
})();
