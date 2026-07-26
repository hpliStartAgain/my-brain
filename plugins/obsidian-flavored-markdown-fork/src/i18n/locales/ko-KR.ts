export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "노트",
        abstract: "개요",
        info: "정보",
        todo: "할일",
        tip: "팁",
        success: "성공",
        question: "질문",
        warning: "주의",
        failure: "실패",
        danger: "위험",
        bug: "버그",
        example: "예시",
        quote: "인용",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `${targetSlug}의 포함`,
        linkToOriginal: "원본 링크",
      },
    },
  },
};
