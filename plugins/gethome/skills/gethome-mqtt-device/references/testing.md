# Testing a device, and finding out why it did not appear

## Watch the broker

With the Mosquitto clients installed on a computer on the same network
(`brew install mosquitto`, `sudo apt install mosquitto-clients`), and the
password in an environment variable rather than typed into the command:

```sh
export GETHOME_HUB=192.168.1.50
read -rs GETHOME_MQTT_PASSWORD; export GETHOME_MQTT_PASSWORD   # paste, then Enter

# Everything under gethome/, live
mosquitto_sub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" -t 'gethome/#' -v

# Only what the broker is holding retained — what the hub reads when it restarts
mosquitto_sub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" -t 'gethome/#' -v --retained-only
```

gethome studio's MQTT view shows the same traffic, live, without a terminal.

## Play the hub's part

The `gethome` account may publish anywhere under `gethome/`, so you can send
the commands the hub would:

```sh
mosquitto_pub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" \
  -t gethome/device/greenhouse/set -m '{"type":"toggle"}'
```

The device should apply it and publish its new state within a second. Then do
the same from a gethome app: the device's card, its page and a scene should
all work it.

## Play the device's part

Before writing firmware, publish the document and a state by hand and look at
the result in the app:

```sh
mosquitto_pub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" -r \
  -t gethome/discovery/test-device/config \
  -m '{"name":"Test device","endpoints":[{"endpointId":1,"deviceKind":"outlet","capabilities":["onOff"],"primary":"onOff"}]}'
mosquitto_pub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" -r \
  -t gethome/device/test-device/state -m '{"onOff":true}'

# …and remove it again
mosquitto_pub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" -r -n -t gethome/discovery/test-device/config
mosquitto_pub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" -r -n -t gethome/device/test-device/state
```

## Ask the hub what it made of it

With an API key (see the `gethome-hub-api` skill) in `GETHOME_API_KEY`:

```sh
curl -s -H "Authorization: Bearer $GETHOME_API_KEY" "http://$GETHOME_HUB:8420/api/v1/devices" |
  jq '.[] | select(.adapter == "mqtt" and .externalId == "greenhouse")'

curl -s -H "Authorization: Bearer $GETHOME_API_KEY" "http://$GETHOME_HUB:8420/api/v1/activity?limit=20" |
  jq -r '.[] | "\(.at)  \(.message)"'
```

A refused document shows in the activity as *Rejected invalid MQTT discovery
config for "<deviceId>".* A refused state message is only in the hub's own
log: on the hub, `gethome-hubctl logs 300 | grep -i mqtt`.

## When something is wrong

| Symptom | Usual cause |
|---|---|
| The board cannot connect | wrong password (the broker answers "not authorised"), wrong address, or the hub's address changed — give it a DHCP reservation |
| It worked until the hub was updated | the hub predates broker passwords and the update closed the broker; set the username and password |
| The device never appears | the document has an unknown key (activity says so), the `deviceId` has a character outside `[A-Za-z0-9_-]` (silently ignored), or the payload is not JSON |
| It appears but shows nothing | the state message was refused whole: an unknown key, a decimal where an integer belongs, a nested object missing its required field, or an endpoint the document did not declare |
| A thermostat keeps switching itself off | a `thermostat` patch without `systemMode`, which defaults to 0 |
| A value is a hundred times off | native units sent instead of canonical ones — °C instead of hundredths, watts instead of milliwatts, percent instead of 1–254 |
| It shows offline | availability is not exactly `online`, or the last will fired because the board stopped sending keepalives |
| Commands never arrive | subscribed to `…/set/1`: endpoint 1's commands come on `…/set` |
| Commands fail after the hub restarts | the document was not retained, so the hub does not know the device until it announces itself again |
| A button press repeats after a restart | the press was published retained |
