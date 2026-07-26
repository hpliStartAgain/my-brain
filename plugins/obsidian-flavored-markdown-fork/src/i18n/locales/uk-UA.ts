export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Примітка",
        abstract: "Абстракт",
        info: "Інформація",
        todo: "Завдання",
        tip: "Порада",
        success: "Успіх",
        question: "Питання",
        warning: "Попередження",
        failure: "Невдача",
        danger: "Небезпека",
        bug: "Баг",
        example: "Приклад",
        quote: "Цитата",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Видобуто з ${targetSlug}`,
        linkToOriginal: "Посилання на оригінал",
      },
    },
  },
};
