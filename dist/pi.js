(function () {
  document.querySelectorAll(".install-row").forEach(function (row) {
    var code = row.querySelector("code");
    var btn = row.querySelector(".copy");
    if (!code || !btn) return;
    btn.addEventListener("click", function () {
      var text = code.textContent || "";
      navigator.clipboard.writeText(text).then(function () {
        var prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1400);
      }).catch(function () {
        btn.textContent = "Select";
      });
    });
  });
})();
