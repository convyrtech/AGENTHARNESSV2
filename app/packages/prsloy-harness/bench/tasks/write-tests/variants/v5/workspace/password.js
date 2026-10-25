// Надёжность пароля: короче 8 символов — «слабый»; от 8 с цифрой и заглавной буквой — «надёжный»;
// иначе «средний».
function strength(password) {
  if (password.length < 8) return "слабый";
  if (/\d/.test(password) && /[A-ZА-ЯЁ]/.test(password)) return "надёжный";
  return "средний";
}

module.exports = { strength };
