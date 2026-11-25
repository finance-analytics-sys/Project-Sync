/**
 * Location service — captures GPS coordinates and calculates
 * distance to the employee's assigned office.
 *
 * Previously enforced a geofence radius; now captures location
 * metadata only (no blocking). The haversine function and office
 * lookup are kept for distance display in timecards and logs.
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
 * Capture location metadata without enforcing any restriction.
 * Returns { office, distance, withinGeofence } or { office: null } if no office assigned.
 */
function captureLocation(userOfficeCode, latitude, longitude) {
  const office = db.findOne('offices', (o) => o.code === userOfficeCode);
  if (!office) {
    return { office: null, distance: null, withinGeofence: false };
  }

  const distance = Math.round(haversineMeters(latitude, longitude, office.latitude, office.longitude));
  return {
    office,
    distance,
    withinGeofence: distance <= RADIUS_METERS,
  };
}

/**
 * Format location for display: "Jenkintown (45m)" or "Remote — 2.3km from Jenkintown"
 */
function formatLocationLabel(officeCode, latitude, longitude) {
  const result = captureLocation(officeCode, latitude, longitude);
  if (!result.office) return 'Unknown location';

  if (result.withinGeofence) {
    return `${result.office.name} (${result.distance}m)`;
  }

  const km = (result.distance / 1000).toFixed(1);
  return `Remote — ${result.distance > 1000 ? km + 'km' : result.distance + 'm'} from ${result.office.name}`;
}

// Keep old export name for backward compatibility during transition
function validateLocation(userOfficeCode, latitude, longitude) {
  const result = captureLocation(userOfficeCode, latitude, longitude);
  // Always allowed now — no geofence enforcement
  return {
    allowed: true,
    office: result.office,
    distance: result.distance,
    withinGeofence: result.withinGeofence,
  };
}

module.exports = { validateLocation, captureLocation, formatLocationLabel, haversineMeters, RADIUS_METERS };
