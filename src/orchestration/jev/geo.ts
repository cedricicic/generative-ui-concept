/**
 * Where the tour's cities are, so distance is computed rather than judged.
 *
 * Claude was asked to know that Milwaukee is a drive from Chicago and Memphis is
 * not. Jev is a decision model and is weak at exactly this kind of spatial and
 * numeric reasoning, so the page works it out here and hands Jev the answer as a
 * fact. The app gets the same thing for free: every catalog venue carries a
 * latitude and longitude.
 *
 * City-centre coordinates, public and approximate. Precise enough for "a drive
 * or a flight", which is the only question they answer.
 */

export const CITY_COORDINATES: Record<string, readonly [number, number]> = {
    Anaheim: [33.84, -117.91],
    Atlanta: [33.75, -84.39],
    Boston: [42.36, -71.06],
    Buffalo: [42.89, -78.88],
    Charlotte: [35.23, -80.84],
    Chicago: [41.88, -87.63],
    Cleveland: [41.5, -81.69],
    Columbus: [39.96, -83.0],
    Dallas: [32.78, -96.8],
    Denver: [39.74, -104.99],
    Detroit: [42.33, -83.05],
    Houston: [29.76, -95.37],
    Indianapolis: [39.77, -86.16],
    'Las Vegas': [36.17, -115.14],
    'Los Angeles': [34.05, -118.24],
    Memphis: [35.15, -90.05],
    Miami: [25.76, -80.19],
    Milwaukee: [43.04, -87.91],
    Nashville: [36.16, -86.78],
    'New York': [40.71, -74.01],
    Newark: [40.74, -74.17],
    'Oklahoma City': [35.47, -97.52],
    'Palm Springs': [33.83, -116.55],
    Philadelphia: [39.95, -75.17],
    Phoenix: [33.45, -112.07],
    Pittsburgh: [40.44, -80.0],
    Portland: [45.52, -122.68],
    Sacramento: [38.58, -121.49],
    'Salt Lake City': [40.76, -111.89],
    'San Antonio': [29.42, -98.49],
    'San Francisco': [37.77, -122.42],
    Seattle: [47.61, -122.33],
    'St. Louis': [38.63, -90.2],
    'St. Paul': [44.95, -93.09],
    Tampa: [27.95, -82.46],
    Washington: [38.91, -77.04],
}

/** Close enough to go without planning a trip. */
export const HOME_MILES = 60

/**
 * Straight-line miles a visitor who "can drive a few hours" will cover. Roads add
 * 15-25%, so 300 straight is roughly a four to five hour drive.
 */
export const DRIVE_MILES = 300

export function milesBetween(from: string, to: string): number | null {
    const a = CITY_COORDINATES[from]
    const b = CITY_COORDINATES[to]
    if (!a || !b) return null

    const radians = (degrees: number) => (degrees * Math.PI) / 180
    const dLat = radians(b[0] - a[0])
    const dLon = radians(b[1] - a[1])
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(dLon / 2) ** 2

    return Math.round(3959 * 2 * Math.asin(Math.sqrt(h)))
}

export type Reach = 'home' | 'drive' | 'flight' | 'unknown'

export function reachFrom(metro: string | null, city: string): Reach {
    if (metro === null) return 'unknown'
    const miles = milesBetween(metro, city)
    if (miles === null) return 'unknown'
    if (miles <= HOME_MILES) return 'home'
    if (miles <= DRIVE_MILES) return 'drive'
    return 'flight'
}
