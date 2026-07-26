export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Ghi chú",
        abstract: "Tổng quan",
        info: "Thông tin",
        todo: "Cần phải làm",
        tip: "Gợi ý",
        success: "Thành công",
        question: "Câu hỏi",
        warning: "Cảnh báo",
        failure: "Thất bại",
        danger: "Nguy hiểm",
        bug: "Lỗi",
        example: "Ví dụ",
        quote: "Trích dẫn",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) =>
          `Trích dẫn toàn bộ từ ${targetSlug}`,
        linkToOriginal: "Xem trang gốc",
      },
    },
  },
};
