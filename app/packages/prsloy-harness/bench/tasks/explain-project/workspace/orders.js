const fs = require("node:fs");

const FILE = "orders.json";

function saveOrder(order) {
  const all = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
  all.push({ ...order, at: new Date().toISOString() });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

module.exports = { saveOrder };
