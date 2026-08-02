// Thai public holidays.
// FIXED = fixed-date national holidays that recur every year ('MM-DD' -> name).
// BY_YEAR = year-specific (พ.ศ.) movable Buddhist days + cabinet substitution/
//   special days, which differ each year and must be entered per year.
const Holidays = {
    FIXED: {
        '01-01': 'วันขึ้นปีใหม่',
        '04-06': 'วันจักรี',
        '04-13': 'วันสงกรานต์',
        '04-14': 'วันสงกรานต์',
        '04-15': 'วันสงกรานต์',
        '05-01': 'วันแรงงานแห่งชาติ',
        '05-04': 'วันฉัตรมงคล',
        '06-03': 'วันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าฯ พระบรมราชินี',
        '07-28': 'วันเฉลิมพระชนมพรรษา ร.10',
        '08-12': 'วันแม่แห่งชาติ',
        '10-13': 'วันนวมินทรมหาราช',
        '10-23': 'วันปิยมหาราช',
        '12-05': 'วันชาติ / วันพ่อแห่งชาติ',
        '12-10': 'วันรัฐธรรมนูญ',
        '12-31': 'วันสิ้นปี'
    },

    // verified from cabinet calendar for พ.ศ. 2569 (2026)
    BY_YEAR: {
        2569: {
            '01-02': 'วันหยุดพิเศษ (ครม.)',
            '03-03': 'วันมาฆบูชา',
            '05-31': 'วันวิสาขบูชา',
            '06-01': 'ชดเชยวันวิสาขบูชา',
            '07-29': 'วันอาสาฬหบูชา',
            '07-30': 'วันเข้าพรรษา',
            '12-07': 'ชดเชยวันคล้ายวันพระบรมราชสมภพ ร.9'
        }
    },

    pad(n) { return String(n).padStart(2, '0'); },

    // name of the holiday on this date, or null. user-added holidays override the built-ins.
    get(beYear, month, day) {
        const key = this.pad(month) + '-' + this.pad(day);
        const custom = (typeof App !== 'undefined' && App.data.customHolidays && App.data.customHolidays[beYear]) || null;
        if (custom && custom[key]) return custom[key];
        const y = this.BY_YEAR[beYear];
        if (y && y[key]) return y[key];
        return this.FIXED[key] || null;
    }
};
