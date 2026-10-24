/* Instance brand + line-icon sprite. Brand comes from the domain: hans.report -> "Hans.report!". */
(function () {
  var host = location.hostname.replace(/^www\./, "");
  var parts = host.split(".");
  var name = parts[0] || "alfred";
  var tld = parts.length > 1 ? parts.slice(1).join(".") : "report";
  if (host === "localhost" || /^[\d.]+$/.test(host)) { name = "alfred"; tld = "report"; }
  var Name = name.charAt(0).toUpperCase() + name.slice(1);
  window.ALFRED_BRAND = { name: name, Name: Name, tld: tld, full: Name + "." + tld + "!", wake: Name + "." + tld + "!" };
  var I = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
    wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10.5v3M21 12h0"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1.2"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
    unarchive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1.2"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M12 17v-5M9.5 14.5 12 12l2.5 2.5"/>',
    alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>',
    x: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
    run: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3"/><path d="M12 7.5V12l3 2"/>',
    coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.4-2.6-1.2M12 6.5V8M12 16v1.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    back: '<path d="M14.5 6 8.5 12l6 6"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>'
  };
  var s = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">';
  for (var k in I) s += '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + I[k] + "</symbol>";
  s += "</svg>";
  function apply() {
    if (!document.getElementById("i-search")) document.body.insertAdjacentHTML("afterbegin", s);
    document.querySelectorAll("[data-brand]").forEach(function (el) {
      el.innerHTML = '<span class="al">' + Name.slice(0, 2) + '</span>' + Name.slice(2) + '<span class="g">.</span>' + tld + '<span class="g">!</span>';
      el.setAttribute("aria-label", Name + "." + tld + "!");
    });
    document.querySelectorAll("[data-brand-text]").forEach(function (el) { el.textContent = Name + "." + tld + "!"; });
    document.querySelectorAll("[data-wake]").forEach(function (el) { el.textContent = "\u201C" + Name + "." + tld + "!\u201D"; });
    if (document.title.indexOf("Alfred.report!") >= 0 && name !== "alfred") document.title = document.title.replace("Alfred.report!", Name + "." + tld + "!");
  }
  window.alfredIcon = function (n, cls) { return '<svg class="ic ' + (cls || "") + '" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
