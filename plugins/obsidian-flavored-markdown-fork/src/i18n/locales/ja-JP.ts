export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "ノート",
        abstract: "抄録",
        info: "情報",
        todo: "やるべきこと",
        tip: "ヒント",
        success: "成功",
        question: "質問",
        warning: "警告",
        failure: "失敗",
        danger: "危険",
        bug: "バグ",
        example: "例",
        quote: "引用",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `${targetSlug}のまとめ`,
        linkToOriginal: "元記事へのリンク",
      },
    },
  },
};
