'use strict';

const COMMON_RESPONSES = {
  collect_name: {
    en: () => 'What is your name?',
    ar: () => 'ما اسمك؟',
  },
  collect_phone: {
    en: () => 'What is your phone number?',
    ar: () => 'ما رقم هاتفك؟',
  },
  invalid_name: {
    en: () => 'Please enter a valid name using letters only before continuing.',
    ar: () => 'يرجى إدخال اسم صحيح باستخدام الأحرف فقط قبل المتابعة.',
  },
  invalid_phone: {
    en: () => 'Please enter a valid phone number.',
    ar: () => 'من فضلك اكتب رقم هاتف صحيح.',
  },
  active_ready: {
    en: (name) => `Perfect, ${name}. How can I help you today?`,
    ar: (name) => `ممتاز يا ${name}. كيف أقدر أساعدك اليوم؟`,
  },
  active_ready_again: {
    en: (name) => `Welcome back, ${name}. How can I help you today?`,
    ar: (name) => `\u0646\u0648\u0631\u062a\u0646\u0627 \u0645\u0631\u0629 \u062b\u0627\u0646\u064a\u0629 \u064a\u0627 ${name}. \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0627\u0644\u064a\u0648\u0645\u061f`,
  },
  human_joined: {
    en: () => 'Customer support joined the chat.',
    ar: () => 'انضم فريق خدمة العملاء إلى المحادثة.',
  },
  error: {
    en: (business) => `Something went wrong. Please contact us at ${business?.phone || 'our contact number'}.`,
    ar: (business) => `حصل خطأ تقني. تواصل معنا على ${business?.phone || 'رقم التواصل'}.`,
  },
};

module.exports = { COMMON_RESPONSES };
