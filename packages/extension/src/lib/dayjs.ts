import dayjs from 'dayjs'
import 'dayjs/locale/en.js'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import duration from 'dayjs/plugin/duration.js'
import utc from 'dayjs/plugin/utc.js'
import isBetween from 'dayjs/plugin/isBetween.js'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js'
import isoWeek from 'dayjs/plugin/isoWeek.js'

dayjs.locale('en')
dayjs.extend(relativeTime)
dayjs.extend(duration)
dayjs.extend(utc)
dayjs.extend(isBetween)
dayjs.extend(isoWeek)

dayjs.extend(isSameOrAfter)
dayjs.extend(isSameOrBefore)

export default dayjs
