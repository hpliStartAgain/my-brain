export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "笔记",
        abstract: "摘要",
        info: "提示",
        todo: "待办",
        tip: "提示",
        success: "成功",
        question: "问题",
        warning: "警告",
        failure: "失败",
        danger: "危险",
        bug: "错误",
        example: "示例",
        quote: "引用",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `包含${targetSlug}`,
        linkToOriginal: "指向原始笔记的链接",
      },
    },
  },
};
