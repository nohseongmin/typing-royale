/* 첫 페인트 전에 테마를 정해 둔다. 늦게 바꾸면 흰 화면이 한 번 번쩍인다 */
try { document.documentElement.dataset.theme = localStorage.getItem("tr_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
catch (e) { document.documentElement.dataset.theme = "light"; }
