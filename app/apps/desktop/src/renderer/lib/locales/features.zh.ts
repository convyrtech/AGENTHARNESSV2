/**
 * Messages of the features taken from open-source analogs (research 19 §1), zh. Spread
 * into the locale table; `zh` is the key source.
 */
export const featuresZh = {
  "features.zip.action": "下载压缩包",
  "features.zip.saved": "压缩包已保存：{name}",
  "features.zip.empty": "项目里没有可打包的文件。",
  "features.zip.tooBig": "项目超过 200 MB，无法打包。",
  "features.zip.failed": "无法保存压缩包。",
  "features.pick.start": "在页面上选择",
  "features.pick.cancel": "取消选择",
  "features.pick.hint": "点击页面上要修改的地方。Esc 取消。",
  "features.pick.picked": "已选择：{what}。在下方写下要修改什么。",
  "features.pick.block.title": "页面 {page} 上的位置",
  "features.pick.block.element": "元素",
  "features.pick.block.text": "文字",
  "features.pick.block.code": "代码",
  "features.errors.one": "页面上有错误",
  "features.errors.many": "页面上有 {count} 个错误",
  "features.errors.fix": "修复",
  "features.errors.hide": "隐藏",
  "features.errors.prompt": "修复页面 {page} 上的错误。浏览器显示：",
  "features.errors.missing": "文件没有加载：{file}",
  "features.pick.block.ask": "这里要改什么：",
} as const;
