// Business types offered when creating an account or a company: [stored value, label shown]. The value is only a label (nothing
// in the books depends on it), so new types can be added freely; the first six are the original ones and must stay valid.
export const SECTOR_LIST = [
  ['trading', 'Trading'], ['wholesale', 'Wholesale and distribution'], ['retail', 'Retail shop'], ['manufacturing', 'Manufacturing'],
  ['service', 'Professional and business services'], ['it', 'IT and software services'], ['freelancer', 'Freelancer or consultant'],
  ['ecommerce', 'E-commerce seller'], ['restaurant', 'Restaurant, cafe or catering'], ['hotel', 'Hotel and hospitality'],
  ['hospital', 'Hospital, clinic or lab'], ['pharmacy', 'Pharmacy'], ['education', 'Education and training'],
  ['construction', 'Construction and real estate'], ['transport', 'Transport and logistics'], ['agriculture', 'Agriculture and food processing'],
  ['textile', 'Textile and garments'], ['automobile', 'Automobile and spare parts'], ['electronics', 'Electronics and electrical'],
  ['jewellery', 'Jewellery and bullion'], ['wellness', 'Salon, spa and fitness'], ['media', 'Media, advertising and events'],
  ['ngo', 'Trust, society or non-profit'], ['other', 'Other'],
];
export const SECTORS = SECTOR_LIST.map(([v]) => v);
