export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Nota",
        abstract: "Abstrato",
        info: "Info",
        todo: "Pendência",
        tip: "Dica",
        success: "Sucesso",
        question: "Pergunta",
        warning: "Aviso",
        failure: "Falha",
        danger: "Perigo",
        bug: "Bug",
        example: "Exemplo",
        quote: "Citação",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transcrever de ${targetSlug}`,
        linkToOriginal: "Link ao original",
      },
    },
  },
};
