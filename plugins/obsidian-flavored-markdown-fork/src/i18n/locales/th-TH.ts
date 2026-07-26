export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "หมายเหตุ",
        abstract: "บทคัดย่อ",
        info: "ข้อมูล",
        todo: "ต้องทำเพิ่มเติม",
        tip: "คำแนะนำ",
        success: "เรียบร้อย",
        question: "คำถาม",
        warning: "คำเตือน",
        failure: "ข้อผิดพลาด",
        danger: "อันตราย",
        bug: "บั๊ก",
        example: "ตัวอย่าง",
        quote: "คำพูกยกมา",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `รวมข้ามเนื้อหาจาก ${targetSlug}`,
        linkToOriginal: "ดูหน้าต้นทาง",
      },
    },
  },
};
