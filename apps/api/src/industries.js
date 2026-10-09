// Lists for the new-business onboarding wizard, ported from the reference prototype (IBMP_App_v6.3.html): entity types with their
// descriptions, the nature of business, the GICS-style industry list, turnover slabs and employee ranges.
// The prototype's own entity codes map onto the values the business profile stores (sole_prop -> proprietorship, pvt_ltd ->
// private_limited, pub_ltd -> public_limited, govt -> other).

export const ENTITY_TYPE_LIST = [
  { value: 'proprietorship', label: 'Sole Proprietorship', description: 'Sole Proprietorship — Single owner, unlimited liability. No separate legal entity. ITR-3/4.' },
  { value: 'partnership', label: 'Partnership Firm', description: 'Partnership Firm — 2+ partners, governed by Partnership Act 1932. ITR-5.' },
  { value: 'llp', label: 'Limited Liability Partnership (LLP)', description: 'LLP — Hybrid entity with limited liability. Governed by LLP Act 2008. ROC filings required.' },
  { value: 'private_limited', label: 'Private Limited Company', description: 'Private Limited Company — Separate legal entity, limited liability. Companies Act 2013. Annual ROC, AGM, Board meetings.' },
  { value: 'public_limited', label: 'Public Limited Company', description: 'Public Limited Company — Can raise public funds. Stringent compliance: SEBI LODR, quarterly results, AGM.' },
  { value: 'opc', label: 'One Person Company (OPC)', description: 'One Person Company — Single promoter with corporate structure. Simpler ROC compliance than Pvt Ltd.' },
  { value: 'huf', label: 'Hindu Undivided Family (HUF)', description: 'Hindu Undivided Family — Family business managed by the Karta, taxed as a separate unit with its own PAN.' },
  { value: 'trust', label: 'Trust (Public / Private)', description: 'Trust — For charitable/religious purposes. 12A/80G registration for income tax exemption.' },
  { value: 'society', label: 'Society / NGO', description: 'Society/NGO — Registered under Societies Registration Act. Annual returns, FCRA if foreign funds.' },
  { value: 'other', label: 'Government / PSU / Other', description: 'Government / PSU — Special accounting and audit requirements. CAG audit. Choose this for any other kind of entity too.' },
];

export const NATURE_LIST = [
  { value: 'trading', label: 'Trading', description: 'Buy & sell goods', hint: 'Trading: Purchases from suppliers → sells to customers. Ledgers include stock-in-trade, purchases, sales.' },
  { value: 'manufacturing', label: 'Manufacturing', description: 'Produce goods', hint: 'Manufacturing: Raw materials → production → finished goods. Includes WIP, RM, FG inventory, factory overhead.' },
  { value: 'service', label: 'Service Provider', description: 'Provide services', hint: 'Service: No inventory tracking. Revenue from services, project billing, consultancy.' },
];

export const INDUSTRIES = [
  // Energy
  { code: '1010', name: 'Oil & Gas Exploration', sector: 'Energy' },
  { code: '1020', name: 'Coal & Consumable Fuels', sector: 'Energy' },
  { code: '1030', name: 'Oil & Gas Refining', sector: 'Energy' },
  { code: '1040', name: 'Renewable Energy', sector: 'Energy' },
  // Materials
  { code: '1510', name: 'Chemicals & Petrochemicals', sector: 'Materials' },
  { code: '1520', name: 'Construction Materials', sector: 'Materials' },
  { code: '1530', name: 'Metal & Mining', sector: 'Materials' },
  { code: '1540', name: 'Paper & Forest Products', sector: 'Materials' },
  { code: '1550', name: 'Fertilizers & Agricultural Chemicals', sector: 'Materials' },
  // Industrials
  { code: '2010', name: 'Aerospace & Defence', sector: 'Industrials' },
  { code: '2020', name: 'Auto Parts & Components', sector: 'Industrials' },
  { code: '2030', name: 'Electrical Equipment', sector: 'Industrials' },
  { code: '2040', name: 'Industrial Machinery', sector: 'Industrials' },
  { code: '2050', name: 'Construction & Engineering', sector: 'Industrials' },
  { code: '2060', name: 'Logistics & Transportation', sector: 'Industrials' },
  { code: '2070', name: 'Packaging', sector: 'Industrials' },
  // Consumer Discretionary
  { code: '2510', name: 'Automobiles & Two-Wheelers', sector: 'Consumer Discretionary' },
  { code: '2520', name: 'Electric Vehicles (EV)', sector: 'Consumer Discretionary' },
  { code: '2530', name: 'Consumer Electronics', sector: 'Consumer Discretionary' },
  { code: '2540', name: 'Apparel & Textiles', sector: 'Consumer Discretionary' },
  { code: '2550', name: 'Hotels & Hospitality', sector: 'Consumer Discretionary' },
  { code: '2560', name: 'Media & Entertainment', sector: 'Consumer Discretionary' },
  { code: '2570', name: 'Retail — General Merchandise', sector: 'Consumer Discretionary' },
  // Consumer Staples
  { code: '3010', name: 'Food & Beverages Manufacturing', sector: 'Consumer Staples' },
  { code: '3020', name: 'FMCG — Personal Care', sector: 'Consumer Staples' },
  { code: '3030', name: 'Tobacco', sector: 'Consumer Staples' },
  { code: '3040', name: 'Agriculture & Agri-processing', sector: 'Consumer Staples' },
  { code: '3050', name: 'Supermarkets & Grocery Retail', sector: 'Consumer Staples' },
  // Healthcare
  { code: '3510', name: 'Pharmaceuticals', sector: 'Healthcare' },
  { code: '3520', name: 'Medical Devices & Equipment', sector: 'Healthcare' },
  { code: '3530', name: 'Hospitals & Clinics', sector: 'Healthcare' },
  { code: '3540', name: 'Healthcare IT', sector: 'Healthcare' },
  { code: '3550', name: 'Diagnostics & Laboratories', sector: 'Healthcare' },
  { code: '3560', name: 'Pharmacy — Retail', sector: 'Healthcare' },
  // Financials
  { code: '4010', name: 'Banking & NBFCs', sector: 'Financials' },
  { code: '4020', name: 'Insurance', sector: 'Financials' },
  { code: '4030', name: 'Asset Management', sector: 'Financials' },
  { code: '4040', name: 'Stock Broking & Exchanges', sector: 'Financials' },
  { code: '4050', name: 'Microfinance', sector: 'Financials' },
  // IT & Technology
  { code: '4510', name: 'IT Services & Consulting', sector: 'Information Technology' },
  { code: '4520', name: 'Software Products (SaaS)', sector: 'Information Technology' },
  { code: '4530', name: 'Hardware & Semiconductor', sector: 'Information Technology' },
  { code: '4540', name: 'E-Commerce & Digital Platforms', sector: 'Information Technology' },
  { code: '4550', name: 'Telecom & Networks', sector: 'Information Technology' },
  { code: '4560', name: 'Cybersecurity', sector: 'Information Technology' },
  // Communication
  { code: '5010', name: 'Telecom Services', sector: 'Communication Services' },
  { code: '5020', name: 'Internet & Digital Media', sector: 'Communication Services' },
  // Utilities
  { code: '5510', name: 'Electric Utilities', sector: 'Utilities' },
  { code: '5520', name: 'Water Supply & Sanitation', sector: 'Utilities' },
  { code: '5530', name: 'Renewable Power Generation', sector: 'Utilities' },
  // Real Estate
  { code: '6010', name: 'Real Estate Development', sector: 'Real Estate' },
  { code: '6020', name: 'Real Estate Investment (REITs)', sector: 'Real Estate' },
  { code: '6030', name: 'Property Management', sector: 'Real Estate' },
  // Professional Services
  { code: '7010', name: 'Legal Services', sector: 'Professional Services' },
  { code: '7020', name: 'Accounting & CA Firms', sector: 'Professional Services' },
  { code: '7030', name: 'Management Consulting', sector: 'Professional Services' },
  { code: '7040', name: 'Engineering & Technical Services', sector: 'Professional Services' },
  { code: '7050', name: 'Staffing & HR Services', sector: 'Professional Services' },
  // Education
  { code: '8010', name: 'Schools & K-12 Education', sector: 'Education' },
  { code: '8020', name: 'Higher Education & Universities', sector: 'Education' },
  { code: '8030', name: 'EdTech & Online Learning', sector: 'Education' },
  { code: '8040', name: 'Vocational & Skill Training', sector: 'Education' },
  // Agriculture
  { code: '9010', name: 'Crop Production & Farming', sector: 'Agriculture' },
  { code: '9020', name: 'Seeds & Agricultural Inputs', sector: 'Agriculture' },
  { code: '9030', name: 'Poultry & Dairy', sector: 'Agriculture' },
  { code: '9040', name: 'Aquaculture & Fisheries', sector: 'Agriculture' },
  // Non-profit
  { code: '9510', name: 'NGO / Charitable Trust', sector: 'Non-Profit & Social' },
  { code: '9520', name: 'Religious Trust', sector: 'Non-Profit & Social' },
  { code: '9530', name: 'Social Enterprise', sector: 'Non-Profit & Social' },
];

export const TURNOVER_SLABS = [
  { value: 'below_1_5cr', label: 'Below ₹1.5 Crore' },
  { value: '1_5cr_to_5cr', label: '₹1.5 Cr – ₹5 Cr' },
  { value: '5cr_to_20cr', label: '₹5 Cr – ₹20 Cr' },
  { value: 'above_20cr', label: 'Above ₹20 Crore' },
];

export const EMPLOYEE_RANGES = [
  { value: '1_10', label: '1–10 (Micro)' },
  { value: '11_50', label: '11–50 (Small)' },
  { value: '51_250', label: '51–250 (Medium)' },
  { value: 'above_250', label: '250+ (Large)' },
];

// Which stored business type (src/sectors.js) an industry stands for. Industries not listed fall back to the nature of business.
const INDUSTRY_SECTOR = {
  2020: 'automobile', 2030: 'electronics', 2050: 'construction', 2060: 'transport', 2510: 'automobile', 2520: 'automobile', 2530: 'electronics',
  2540: 'textile', 2550: 'hotel', 2560: 'media', 2570: 'retail', 3010: 'agriculture', 3040: 'agriculture', 3050: 'retail',
  3530: 'hospital', 3540: 'it', 3550: 'hospital', 3560: 'pharmacy', 4510: 'it', 4520: 'it', 4530: 'electronics', 4540: 'ecommerce', 4560: 'it',
  5020: 'media', 6010: 'construction', 6030: 'construction', 7010: 'service', 7020: 'service', 7030: 'service', 7040: 'service', 7050: 'service',
  8010: 'education', 8020: 'education', 8030: 'education', 8040: 'education', 9010: 'agriculture', 9020: 'agriculture', 9030: 'agriculture', 9040: 'agriculture',
  9510: 'ngo', 9520: 'ngo', 9530: 'ngo',
};
const NATURE_SECTOR = { trading: 'trading', manufacturing: 'manufacturing', service: 'service' };

/** The stored business type to use when the person did not choose one: from the industry if it says something specific, else from the nature. */
export const defaultSector = (nature, industryCode) => INDUSTRY_SECTOR[industryCode] ?? NATURE_SECTOR[nature] ?? 'other';
