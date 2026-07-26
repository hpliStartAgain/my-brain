export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "筆記",
        abstract: "摘要",
        info: "提示",
        todo: "待辦",
        tip: "提示",
        success: "成功",
        question: "問題",
        warning: "警告",
        failure: "失敗",
        danger: "危險",
        bug: "錯誤",
        example: "範例",
        quote: "引用",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `包含 ${targetSlug}`,
        linkToOriginal: "指向原始筆記的連結",
      },
    },
  },
};
