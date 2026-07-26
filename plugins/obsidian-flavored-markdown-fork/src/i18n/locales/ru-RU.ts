export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Заметка",
        abstract: "Резюме",
        info: "Инфо",
        todo: "Сделать",
        tip: "Подсказка",
        success: "Успех",
        question: "Вопрос",
        warning: "Предупреждение",
        failure: "Неудача",
        danger: "Опасность",
        bug: "Баг",
        example: "Пример",
        quote: "Цитата",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Переход из ${targetSlug}`,
        linkToOriginal: "Ссылка на оригинал",
      },
    },
  },
};
