export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Ескерту",
        abstract: "Аннотация",
        info: "Ақпарат",
        todo: "Істеу керек",
        tip: "Кеңес",
        success: "Сәттілік",
        question: "Сұрақ",
        warning: "Ескерту",
        failure: "Қате",
        danger: "Қауіп",
        bug: "Қате",
        example: "Мысал",
        quote: "Дәйексөз",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `${targetSlug} кірістіру`,
        linkToOriginal: "Бастапқыға сілтеме",
      },
    },
  },
};
