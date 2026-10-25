const nodemailer = require("nodemailer");

const transport = nodemailer.createTransport({ host: "smtp.example.ru", port: 587 });

function notifyManager(order) {
  return transport.sendMail({
    to: "manager@shop.example",
    subject: "Новый заказ",
    text: `Заказ: ${JSON.stringify(order)}`,
  });
}

module.exports = { notifyManager };
