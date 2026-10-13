import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildDeviceUpdateBody, MAX_BRIGHTNESS, MAX_DEVICE_NAME_LENGTH, MAX_SLIDESHOW_SPEED, MAX_SLIDESHOW_STYLE } from "../skylight/device-payload.js";
import { ValidationError } from "../skylight/errors.js";
import { assertNumericId, sameNumericId } from "../skylight/ids.js";
import { mapAlbums, mapDevice, mapDevices, type Device } from "../skylight/types.js";
import { ALL_PHOTOS } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

const devicesPath = (frameId: string) => `/api/frames/${frameId}/devices`;
const dataOf = (json: unknown): unknown => (json as { data?: unknown } | null)?.data;

async function getDevice(ctx: ToolContext, frameId: string, id: string): Promise<Device> {
  const device = mapDevice(dataOf(await ctx.client.request({ method: "GET", path: `${devicesPath(frameId)}/${id}` })));
  if (!device) throw new ValidationError("deviceId", "Skylight returned no device with that id; use skylight_list_devices");
  return device;
}

const deviceIdSchema = z.string().describe("Device id from skylight_list_devices.");

interface DestroyKind {
  tool: string;
  title: string;
  effect: string;
  description: string;
  preview: "wouldReset" | "wouldRemove";
  verb: string;
  done: "reset" | "removed";
  send(ctx: ToolContext, frameId: string, id: string): Promise<unknown>;
}

const DESTROY_KINDS: DestroyKind[] = [
  {
    tool: "skylight_reset_device", title: "Reset a device", preview: "wouldReset", verb: "reset", done: "reset",
    effect: "the screen is wiped and must be set up again",
    description: "Reset a Skylight device: the screen is wiped and must be set up again. This is the most disruptive action in this server. It needs BOTH confirmName (the device's current name, exactly as listed by skylight_list_devices, case-sensitive) AND confirm: true. Without both it makes NO change and returns what would happen. Ask the user to type the device name, never fill confirmName in on your own, and only call with both after they clearly agree.",
    send: (ctx, frameId, id) => ctx.client.request({ method: "POST", path: `${devicesPath(frameId)}/${id}/reset` }),
  },
  {
    tool: "skylight_remove_device", title: "Remove a device from the frame", preview: "wouldRemove", verb: "remove", done: "removed",
    effect: "the device leaves this frame",
    description: "Remove a Skylight device from the frame: the device leaves this frame. It needs BOTH confirmName (the device's current name, exactly as listed by skylight_list_devices, case-sensitive) AND confirm: true. Without both it makes NO change and returns what would happen. Ask the user to type the device name, never fill confirmName in on your own, and only call with both after they clearly agree.",
    send: (ctx, frameId, id) => ctx.client.request({ method: "DELETE", path: `${devicesPath(frameId)}/${id}` }),
  },
];

export function registerDeviceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_devices",
    {
      title: "List devices",
      description: "List the Skylight devices on the frame as { id, name, timezone, brightness, sleepsAt, wakesAt, sleeping, sleepModeOn, showCaption, showHeart, blurEffect, slideshowSpeed, slideshowStyle, startSound, currentAlbumId }. currentAlbumId is \"all\" when the slideshow plays every photo, else an album id. Device ids are needed by the other device tools.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => mapDevices(await ctx.client.request({ method: "GET", path: devicesPath(await ctx.frames.resolve()) })))
  );

  server.registerTool(
    "skylight_update_device",
    {
      title: "Change device settings",
      description: `Change settings on a Skylight device. Only the provided settings change; everything else stays as it is. Covers the name, screen brightness (0-${MAX_BRIGHTNESS}), the nightly sleep window (sleepsAt / wakesAt as HH:mm, with sleepModeOn to turn it on), slideshow options and which album the slideshow plays. Alarms and sleep schedules are not available.`,
      inputSchema: {
        deviceId: deviceIdSchema,
        name: z.string().optional().describe(`New device name, up to ${MAX_DEVICE_NAME_LENGTH} characters.`),
        brightness: z.number().int().min(0).max(MAX_BRIGHTNESS).optional().describe(`Screen brightness 0-${MAX_BRIGHTNESS}.`),
        sleepsAt: z.string().optional().describe("When the screen goes to sleep, HH:mm 24-hour."),
        wakesAt: z.string().optional().describe("When the screen wakes up, HH:mm 24-hour."),
        sleepModeOn: z.boolean().optional().describe("Turn the nightly sleep window on or off."),
        showCaption: z.boolean().optional().describe("Show photo captions in the slideshow."),
        showHeart: z.boolean().optional().describe("Show the heart button on photos."),
        blurEffect: z.boolean().optional().describe("Blurred background behind photos that do not fill the screen."),
        startSound: z.boolean().optional().describe("Play a sound when the device starts."),
        slideshowSpeed: z.number().int().min(1).max(MAX_SLIDESHOW_SPEED).optional().describe(`Seconds each photo shows, 1-${MAX_SLIDESHOW_SPEED}.`),
        slideshowStyle: z.number().int().min(0).max(MAX_SLIDESHOW_STYLE).optional().describe(`Slideshow transition style, 0-${MAX_SLIDESHOW_STYLE}.`),
        albumId: z.string().optional().describe(`Album the slideshow plays: an album id from skylight_list_albums, or "${ALL_PHOTOS}" for every photo.`),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { deviceId, ...settings } = args;
      const id = assertNumericId(deviceId, "deviceId");
      const body = buildDeviceUpdateBody(settings);
      const frameId = await ctx.frames.resolve();
      if (settings.albumId !== undefined && settings.albumId !== ALL_PHOTOS) {
        if (!mapAlbums(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/albums` })).some((a) => sameNumericId(a.id, settings.albumId!))) {
          throw new ValidationError("albumId", `no album ${settings.albumId}; use skylight_list_albums, or "${ALL_PHOTOS}" for every photo`);
        }
      }
      const json = await ctx.client.request<unknown>({ method: "PUT", path: `${devicesPath(frameId)}/${id}`, body });
      return mapDevice(dataOf(json)) ?? { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_set_device_sleep",
    {
      title: "Put a device to sleep or wake it",
      description: "Put the device screen to sleep (asleep: true) or wake it (asleep: false) right now, regardless of the nightly sleep window.",
      inputSchema: { deviceId: deviceIdSchema, asleep: z.boolean().describe("true puts the screen to sleep, false wakes it.") },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.deviceId, "deviceId");
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "POST", path: `${devicesPath(frameId)}/${id}/${args.asleep ? "start_sleep" : "end_sleep"}` });
      return { deviceId: id, asleep: args.asleep };
    })
  );

  for (const kind of DESTROY_KINDS) {
    server.registerTool(
      kind.tool,
      {
        title: kind.title,
        description: kind.description,
        inputSchema: {
          deviceId: deviceIdSchema,
          confirmName: z.string().optional().describe("The device's current name, typed exactly (case-sensitive). Ask the user for it."),
          confirm: z.boolean().optional().describe("Must be true, together with confirmName, to actually do it. Ask the user first."),
        },
        annotations: ANNOTATIONS.destroy,
      },
      (args) => run(async () => {
        const id = assertNumericId(args.deviceId, "deviceId");
        const frameId = await ctx.frames.resolve();
        const device = await getDevice(ctx, frameId, id);
        if (args.confirmName !== undefined && args.confirmName !== device.name) {
          throw new ValidationError("confirmName", `does not match: the device is named "${device.name}" (exact spelling and case)`);
        }
        if (args.confirm !== true || args.confirmName === undefined) {
          return {
            confirmed: false,
            [kind.preview]: { id, name: device.name },
            message: `Nothing was ${kind.done}. This would ${kind.verb} the device "${device.name}": ${kind.effect}. Ask the user to type the device name; then call again with confirmName: "${device.name}" and confirm: true.`,
          };
        }
        await kind.send(ctx, frameId, id);
        return { [kind.done]: true, id, name: device.name };
      })
    );
  }
}
