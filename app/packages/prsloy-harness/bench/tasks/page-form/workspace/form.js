document.getElementById("signup").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  localStorage.setItem("signup", JSON.stringify({ name, phone }));
  document.getElementById("thanks").style.display = "block";
});
