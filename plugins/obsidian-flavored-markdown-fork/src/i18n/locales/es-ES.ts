export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Nota",
        abstract: "Resumen",
        info: "Información",
        todo: "Por hacer",
        tip: "Consejo",
        success: "Éxito",
        question: "Pregunta",
        warning: "Advertencia",
        failure: "Fallo",
        danger: "Peligro",
        bug: "Error",
        example: "Ejemplo",
        quote: "Cita",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transcluido de ${targetSlug}`,
        linkToOriginal: "Enlace al original",
      },
    },
  },
};
