// Доход по вкладу: простые проценты за полные годы.
function income(sum, ratePercent, years) {
  return sum * ratePercent * years;
}

module.exports = { income };
