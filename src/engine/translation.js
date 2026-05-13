'use strict';

const ARABIC_TO_ENGLISH_DICT = {
  // Cafe
  'قهوة': 'coffee',
  'قهوه': 'coffee',
  'قهوا': 'coffee',
  'شاي': 'tea',
  'عصير': 'juice',
  'ماء': 'water',
  'مياه': 'water',
  'فراخ': 'chicken',
  'دجاج': 'chicken',
  'لحم': 'meat',
  'لحمة': 'meat',
  'لحمه': 'meat',
  'جبنة': 'cheese',
  'جبنه': 'cheese',
  'جبن': 'cheese',
  'أجبان': 'cheese',
  'اجبان': 'cheese',
  'حليب': 'milk',
  'لبن': 'milk',
  'شوكولاتة': 'chocolate',
  'شوكولاته': 'chocolate',
  'بطاطس': 'fries',
  'مكرونة': 'pasta',
  'مكرونه': 'pasta',
  'باستا': 'pasta',
  'سلطة': 'salad',
  'سلطه': 'salad',
  'شوربة': 'soup',
  'شوربه': 'soup',
  'حلو': 'dessert',
  'حلويات': 'dessert',
  'خبز': 'bread',
  'عيش': 'bread',
  'سمك': 'fish',
  'تفاح': 'apple',
  'برتقال': 'orange',
  'فراولة': 'strawberry',
  'فراوله': 'strawberry',
  'مانجو': 'mango',
  'مانجا': 'mango',
  'ليمون': 'lemon',
  'نعناع': 'mint',
  'خضار': 'vegetable',
  'خضروات': 'vegetables',

  // Real Estate
  'شقة': 'apartment',
  'شقه': 'apartment',
  'فيلا': 'villa',
  'فلة': 'villa',
  'فله': 'villa',
  'عقار': 'property',
  'عقارات': 'properties',
  'مشروع': 'project',
  'مشاريع': 'projects',
  'مكتب': 'office',
  'مكاتب': 'offices',
  'عيادة': 'clinic',
  'عياده': 'clinic',
  'محل': 'shop',
  'محلات': 'shops',
  'ستوديو': 'studio',
  'استوديو': 'studio',
  'دوبلكس': 'duplex',
  'بينتهاوس': 'penthouse',
  'توين': 'twinhouse',
  'تاون': 'townhouse',
  'مساحة': 'area',
  'مساحه': 'area',
  'غرفة': 'bedroom',
  'غرفه': 'bedroom',
  'غرف': 'bedrooms',
  'حمام': 'bathroom',
  'حمامات': 'bathrooms',
  'قسط': 'installment',
  'تقسيط': 'installments',
  'مقدم': 'down payment',
  'ايجار': 'rent',
  'إيجار': 'rent',
  'بيع': 'sale',
  'للبيع': 'for sale',
  'للايجار': 'for rent',
  'استثمار': 'investment',

  // Clinic
  'دكتور': 'doctor',
  'دكتورة': 'doctor',
  'طبيب': 'doctor',
  'طبيبة': 'doctor',
  'مستشفى': 'hospital',
  'مستشفي': 'hospital',
  'صيدلية': 'pharmacy',
  'صيدليه': 'pharmacy',
  'كشف': 'checkup',
  'فيزيتا': 'visit',
  'تحليل': 'test',
  'تحاليل': 'tests',
  'اشعة': 'x-ray',
  'أشعة': 'x-ray',
  'علاج': 'treatment',
  'دواء': 'medicine',
  'اسنان': 'dental',
  'أسنان': 'dental',
  'جلدية': 'dermatology',
  'جلديه': 'dermatology',
  'اطفال': 'pediatrics',
  'أطفال': 'pediatrics',
  'باطنة': 'internal',
  'باطنه': 'internal',
  'عظام': 'orthopedics',
  'قلب': 'cardiology',
  'عيون': 'ophthalmology',
  'مخ': 'neurology',
  'اعصاب': 'neurology',
  'أعصاب': 'neurology'
};

function translateArabicToEnglish(text) {
  if (!text) return text;
  let processed = text;
  
  // Sort keys by length descending to match longest phrases first if any
  const keys = Object.keys(ARABIC_TO_ENGLISH_DICT).sort((a, b) => b.length - a.length);
  
  for (const ar of keys) {
    const en = ARABIC_TO_ENGLISH_DICT[ar];
    // Replace whole words only, preserving other text around it
    const regex = new RegExp(`(^|\\s)${ar}(?=\\s|$)`, 'g');
    processed = processed.replace(regex, `$1${en}`);
  }
  
  return processed;
}

module.exports = {
  translateArabicToEnglish,
  ARABIC_TO_ENGLISH_DICT
};
