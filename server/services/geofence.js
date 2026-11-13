/**
 * Geofence service — validates that a clock punch is within
 * the configured radius of the employee's assigned office.
 */
const db = require('../db');

const RADIUS_METERS = parseInt(process.env.GEOFENCE_RADIUS_METERS || '200', 10);

/**
 * Haversine distance between two lat/lng points in meters.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check if coordinates are within the geofence of any office the user belongs to.
 * Returns { allowed, office, distance } or { allowed: false, reason }.
 */
function validateLocation(userOfficeCode, latitude, longitude) {
  const office = db.findOne('offices', (o) => o.code === userOfficeCode);
  if (!office) {
    return { allowed: false, reason: 'No office assigned to user' };
  }

  const distance = haversineMeters(latitude, longitude, office.latitude, office.longitude);
  if (distance <= RADIUS_METERS) {
    return { allowed: true, office, distance: Math.round(distance) };
  }

  return {
    allowed: false,
    reason: `You are ${Math.round(distance)}m from the ${office.name} office. Must be within ${RADIUS_METERS}m to clock in/out.`,
    distance: Math.round(distance),
    office,
  };
}

module.exports = { validateLocation, haversineMeters, RADIUS_METERS };
