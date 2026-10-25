// Дифф с настоящей ошибкой: sum вычитает.
export const BUGGY_DIFF = `diff --git a/sum.js b/sum.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/sum.js
@@ -0,0 +1,7 @@
+function sum(a, b) {
+  return a - b;
+}
+function mul(a, b) {
+  return a * b;
+}
+module.exports = { sum, mul };
`;
