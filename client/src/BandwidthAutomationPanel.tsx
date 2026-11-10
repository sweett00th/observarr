import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import SpeedIcon from "@mui/icons-material/Speed";
import SyncIcon from "@mui/icons-material/Sync";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useRef, useState } from "react";

type ThrottleUnit = "Mbps" | "MBps";
type PausedPolicy = "grace" | "active" | "idle";
type ConnectionState = "unknown" | "ok" | "error" | "not_configured";
type DecisionReason =
  | "streams_active"
  | "playback_started"
  | "grace_period"
  | "idle"
  | "jellyfin_unavailable"
  | "disabled";
type ControllerMode =
  | "off"
  | "unrestricted"
  | "throttled"
  | "recovery_grace"
  | "protective_error";
type TriggerSource = "webhook" | "poll" | "manual" | "startup" | "settings";
type WebhookOutcome = "capped" | "already_capped" | "cap_failed" | "check_requested";

type ConnectionStatus = {
  state: ConnectionState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
};

type BandwidthStatus = {
  ok: boolean;
  settings: {
    enabled: boolean;
    throttleBytesPerSecond: number;
    throttleUnit: ThrottleUnit;
    throttleValue: number;
    idlePollIntervalSeconds: number;
    activePollIntervalSeconds: number;
    recoveryGraceSeconds: number;
    pausedPolicy: PausedPolicy;
    pausedGraceSeconds: number;
    updatedAt: string | null;
  };
  configured: { jellyfin: boolean; sabnzbd: boolean };
  lifecycle: string;
  mode: "unrestricted" | "throttled";
  controllerMode: ControllerMode;
  fastPath: { enabled: boolean; reason: string | null };
  lastTrigger: { source: TriggerSource; detail: string; at: string } | null;
  lastWebhook: { event: string; outcome: WebhookOutcome; at: string } | null;
  lastWebhookThrottle: {
    event: string;
    receivedAt: string;
    outcome: "capped" | "cap_failed";
    receivedToRequestMs: number | null;
    requestMs: number | null;
    receivedToAckMs: number | null;
    receivedToReconcileMs: number | null;
  } | null;
  decision: {
    reason: DecisionReason | null;
    graceUntil: string | null;
    nextCheckAt: string | null;
  };
  playback: {
    observedAt: string;
    countedStreams: number;
    playing: number;
    pausedCounted: number;
    pausedIgnored: number;
    stale: number;
    transcoding: number;
    totalSessions: number;
    pendingWebhookStreams: number;
    streams: Array<{
      userName: string | null;
      client: string | null;
      deviceName: string | null;
      itemName: string | null;
      playMethod: string | null;
      isPaused: boolean;
      verdict: "playing" | "paused_counted" | "paused_ignored" | "stale";
      counted: boolean;
    }>;
  } | null;
  jellyfin: ConnectionStatus;
  sabnzbd: ConnectionStatus & {
    observedAt: string | null;
    speedLimitBytesPerSecond: number | null;
    speedLimitPercent: number | null;
    downloadBytesPerSecond: number | null;
    queueStatus: string | null;
    paused: boolean | null;
    version: string | null;
  };
  lastReconcile: {
    at: string;
    trigger: string;
    success: boolean;
    checkOnly: boolean;
  } | null;
  lastSuccessfulReconcileAt: string | null;
  lastChange: {
    at: string;
    fromBytesPerSecond: number | null;
    toBytesPerSecond: number;
    reason: string;
  } | null;
  ownership: {
    ownsLimit: boolean;
    priorLimitBytesPerSecond: number | null;
    appliedLimitBytesPerSecond: number | null;
    restorePending: boolean;
  };
  conflict: {
    suspected: boolean;
    externalChanges: number;
    windowMinutes: number;
    lastAt: string | null;
  };
  notice: { at: string; message: string } | null;
  recentErrors: Array<{
    source: "jellyfin" | "sabnzbd" | "controller";
    message: string;
    firstAt: string;
    lastAt: string;
    count: number;
  }>;
};

type ReconcileResponse = BandwidthStatus & {
  outcome: {
    checkOnly: boolean;
    success: boolean;
    countedStreams: number | null;
    change: { fromBytesPerSecond: number; toBytesPerSecond: number } | null;
    skipped: string | null;
  };
};

type Draft = {
  throttleValue: string;
  throttleUnit: ThrottleUnit;
  idlePollIntervalSeconds: string;
  activePollIntervalSeconds: string;
  recoveryGraceSeconds: string;
  pausedPolicy: PausedPolicy;
  pausedGraceSeconds: string;
};

// Decimal network units: 1 Mb/s = 125,000 bytes/s, 1 MB/s = 1,000,000 bytes/s.
const bytesPerUnit: Record<ThrottleUnit, number> = {
  Mbps: 125_000,
  MBps: 1_000_000,
};
const unitLabels: Record<ThrottleUnit, string> = {
  Mbps: "Mb/s (megabits)",
  MBps: "MB/s (megabytes)",
};
const limits = {
  throttleMbps: { min: 1, max: 10_000 },
  idlePollIntervalSeconds: { min: 2, max: 300 },
  activePollIntervalSeconds: { min: 2, max: 600 },
  recoveryGraceSeconds: { min: 0, max: 3600 },
  pausedGraceSeconds: { min: 0, max: 3600 },
};
const pausedPolicyLabels: Record<PausedPolicy, string> = {
  grace: "Count for a grace period, then ignore",
  active: "Always count (keep the cap while paused)",
  idle: "Never count",
};
const sourceLabels = {
  jellyfin: "Jellyfin",
  sabnzbd: "SABnzbd",
  controller: "Controller",
};
const idleRange = limits.idlePollIntervalSeconds;
const activeRange = limits.activePollIntervalSeconds;
const idleHelp = `Safety-net check while uncapped, and retries after errors ` +
  `(${idleRange.min}–${idleRange.max} s)`;
const activeHelp = `Safety-net check while capped, for a missed stop ` +
  `(${activeRange.min}–${activeRange.max} s)`;
const triggerLabels: Record<TriggerSource, string> = {
  webhook: "Webhook",
  poll: "Scheduled poll",
  manual: "Manual",
  startup: "Startup",
  settings: "Settings change",
};
const webhookOutcomeLabels: Record<WebhookOutcome, string> = {
  capped: "capped SABnzbd",
  already_capped: "already capped, nothing written",
  cap_failed: "SABnzbd didn't accept the cap",
  check_requested: "checked Jellyfin's sessions",
};

/**
 * Dashboard panel for capping SABnzbd while Jellyfin plays. Talks only to
 * /api/bandwidth-automation; URLs and API keys never reach the browser.
 */
export function BandwidthAutomationPanel() {
  const [status, setStatus] = useState<BandwidthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"toggle" | "save" | "reconcile" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastText = useRef("");
  const lastBaseline = useRef<Draft | null>(null);

  /** New status; the form follows saved settings unless it has unsaved edits. */
  function applyStatus(next: BandwidthStatus) {
    setStatus(next);
    const baseline = settingsToDraft(next.settings);
    const previous = lastBaseline.current;
    lastBaseline.current = baseline;
    setDraft((current) =>
      current === null || (previous !== null && sameDraft(current, previous)) ? baseline : current
    );
  }

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      fetch("/api/bandwidth-automation")
        .then(async (response) => {
          const text = await response.text();
          if (!response.ok) {
            throw new Error(
              errorFrom(text) ?? `Status returned ${response.status}`,
            );
          }
          return text;
        })
        .then((text) => {
          if (cancelled) {
            return;
          }
          setLoadError(null);
          // Polled every 2 seconds; an unchanged answer must not re-render.
          if (text !== lastText.current) {
            lastText.current = text;
            applyStatus(JSON.parse(text) as BandwidthStatus);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setLoadError(
              error instanceof Error ? error.message : "Status unavailable",
            );
          }
        });
    }

    refresh();
    const poll = window.setInterval(refresh, 2000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  async function send<T extends BandwidthStatus>(
    kind: "toggle" | "save" | "reconcile",
    path: string,
    init: RequestInit,
  ): Promise<T | null> {
    setBusy(kind);
    setActionError(null);
    setActionMessage(null);

    try {
      const response = await fetch(path, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          errorFrom(text) ?? `Request failed with ${response.status}`,
        );
      }

      const data = JSON.parse(text) as T;
      lastText.current = "";
      applyStatus(data);
      return data;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Request failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  function patchSettings(kind: "toggle" | "save", body: unknown) {
    return send(kind, "/api/bandwidth-automation/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function toggle(enabled: boolean) {
    const data = await patchSettings("toggle", { enabled });
    if (data) {
      setActionMessage(
        enabled ? "Automation is on." : data.notice?.message ??
          "Automation is off. SABnzbd's speed limit is no longer managed.",
      );
    }
  }

  async function save() {
    if (!draft || validateDraft(draft).error) {
      return;
    }

    const data = await patchSettings("save", {
      throttle: {
        value: Number(draft.throttleValue),
        unit: draft.throttleUnit,
      },
      idlePollIntervalSeconds: Number(draft.idlePollIntervalSeconds),
      activePollIntervalSeconds: Number(draft.activePollIntervalSeconds),
      recoveryGraceSeconds: Number(draft.recoveryGraceSeconds),
      pausedPolicy: draft.pausedPolicy,
      pausedGraceSeconds: Number(draft.pausedGraceSeconds),
    });
    if (data) {
      setDraft(settingsToDraft(data.settings));
      setActionMessage("Settings saved.");
    }
  }

  async function reconcile() {
    const data = await send<ReconcileResponse>(
      "reconcile",
      "/api/bandwidth-automation/reconcile",
      {
        method: "POST",
      },
    );
    if (data) {
      setActionMessage(describeOutcome(data));
    }
  }

  if (!status || !draft) {
    return (
      <Card variant="outlined">
        <CardContent>
          <PanelTitle />
          <Box sx={{ mt: 2 }}>
            {loadError
              ? <Alert severity="error">{loadError}</Alert>
              : <CircularProgress size={24} />}
          </Box>
        </CardContent>
      </Card>
    );
  }

  const configured = status.configured.jellyfin && status.configured.sabnzbd;
  const enabled = status.settings.enabled;
  const baseline = settingsToDraft(status.settings);
  const dirty = !sameDraft(draft, baseline);
  const validation = validateDraft(draft);
  const playback = status.playback;
  const sab = status.sabnzbd;
  const showNotice = status.notice && status.notice.at !== dismissedNotice;
  const missing = [
    ...(status.configured.jellyfin ? [] : ["JELLYFIN_URL", "JELLYFIN_API_KEY"]),
    ...(status.configured.sabnzbd ? [] : ["SABNZBD_URL", "SABNZBD_API_KEY"]),
  ];

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2.5} useFlexGap>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ flexWrap: "wrap", rowGap: 1 }}
          >
            <PanelTitle />
            <ModeChip mode={status.controllerMode} />
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip
              title={configured ? "" : "Set the environment variables listed below first"}
            >
              <span>
                <FormControlLabel
                  control={
                    <Switch
                      checked={enabled}
                      disabled={busy !== null || (!configured && !enabled)}
                      onChange={(event) => toggle(event.target.checked)}
                    />
                  }
                  label={busy === "toggle" ? "Saving" : enabled ? "Enabled" : "Disabled"}
                />
              </span>
            </Tooltip>
          </Stack>

          <Typography variant="body2" color="text.secondary">
            Caps SABnzbd's download speed while anyone (remote family included) is playing something
            on Jellyfin, so streams don't buffer, and lifts it once playback has stopped. ObservaRR
            only changes SABnzbd's speed limit: never its queue, jobs, categories or
            post-processing.
          </Typography>

          {!configured && (
            <Alert severity="info">
              Set {missing.join(", ")}{" "}
              on the container (Unraid template) and restart it to use bandwidth automation.
            </Alert>
          )}
          {configured && enabled && !status.fastPath.enabled && (
            <Alert severity="info">
              Instant capping when playback starts is off. {status.fastPath.reason}{" "}
              Set SHARED_SECRET on the container and add it to the Jellyfin webhook (an x-sms-secret
              header) to cap SABnzbd the moment a stream starts.
            </Alert>
          )}
          {loadError && <Alert severity="warning">Status refresh failed: {loadError}</Alert>}
          {status.conflict.suspected && (
            <Alert severity="warning">
              SABnzbd's speed limit was changed outside ObservaRR {status.conflict.externalChanges}
              {" "}
              times in the last {status.conflict.windowMinutes}{" "}
              minutes. Something else (SABnzbd's scheduler, a script, another app) is probably
              setting it too, and the two keep undoing each other. Turn one of them off.
            </Alert>
          )}
          {status.ownership.restorePending && (
            <Alert severity="warning">
              SABnzbd's previous speed limit hasn't been put back yet because SABnzbd couldn't be
              reached. ObservaRR keeps retrying.
            </Alert>
          )}
          {showNotice && status.notice && (
            <Alert
              severity="info"
              onClose={() => setDismissedNotice(status.notice?.at ?? null)}
            >
              {status.notice.message}{" "}
              <Typography
                component="span"
                variant="caption"
                color="text.secondary"
              >
                ({formatRelative(status.notice.at, now)})
              </Typography>
            </Alert>
          )}
          {actionError && <Alert severity="error">{actionError}</Alert>}
          {actionMessage && <Alert severity="success">{actionMessage}</Alert>}

          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <StatTile
                label="Active Jellyfin streams"
                value={playback
                  ? String(playback.countedStreams + playback.pendingWebhookStreams)
                  : "–"}
                detail={playback ? describePlayback(playback) : "Not checked yet"}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <StatTile
                label="SABnzbd speed limit"
                value={sab.speedLimitBytesPerSecond === null
                  ? "–"
                  : sab.speedLimitBytesPerSecond === 0
                  ? "Unlimited"
                  : formatMbps(sab.speedLimitBytesPerSecond)}
                detail={sab.speedLimitBytesPerSecond
                  ? `${formatMBps(sab.speedLimitBytesPerSecond)} · SABnzbd shows ${
                    formatMiBps(sab.speedLimitBytesPerSecond)
                  }`
                  : sab.speedLimitBytesPerSecond === 0
                  ? "No cap set"
                  : "Not checked yet"}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <StatTile
                label="Measured download speed"
                value={sab.downloadBytesPerSecond === null
                  ? "–"
                  : formatMbps(sab.downloadBytesPerSecond)}
                detail={sab.downloadBytesPerSecond === null
                  ? "Not checked yet"
                  : `${formatMBps(sab.downloadBytesPerSecond)}${
                    sab.queueStatus ? ` · queue ${sab.queueStatus.toLowerCase()}` : ""
                  }`}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <StatTile
                label="Decision"
                value={decisionTitle(status)}
                detail={decisionDetail(status, now)}
              />
            </Grid>
          </Grid>

          {playback && playback.streams.length > 0 && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Playing now
              </Typography>
              <Stack spacing={0.75}>
                {playback.streams.map((stream, index) => (
                  <Stack
                    key={`${stream.userName}-${stream.deviceName}-${index}`}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{ flexWrap: "wrap", rowGap: 0.5 }}
                  >
                    <Chip
                      size="small"
                      color={stream.counted ? "warning" : "default"}
                      variant={stream.counted ? "filled" : "outlined"}
                      label={verdictLabel(stream.verdict)}
                    />
                    <Typography variant="body2">
                      {stream.userName ?? "Someone"} · {stream.itemName ?? "something"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {[
                        stream.deviceName,
                        stream.client,
                        playMethodLabel(stream.playMethod),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}

          <Stack
            direction="row"
            spacing={1}
            sx={{ flexWrap: "wrap", rowGap: 1 }}
          >
            <ConnectionChip
              name="Jellyfin"
              status={status.jellyfin}
              now={now}
            />
            <ConnectionChip name="SABnzbd" status={sab} now={now} />
            {sab.paused && (
              <Chip
                size="small"
                variant="outlined"
                label="SABnzbd queue paused"
              />
            )}
          </Stack>

          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <Fact label="Last successful reconciliation">
                {status.lastSuccessfulReconcileAt
                  ? formatWhen(status.lastSuccessfulReconcileAt, now)
                  : enabled
                  ? "None yet"
                  : "Automation is off"}
              </Fact>
            </Grid>
            <Grid item xs={12} md={4}>
              <Fact label="Last speed-limit change">
                {status.lastChange
                  ? (
                    <>
                      {formatWhen(status.lastChange.at, now)}
                      <br />
                      {formatLimit(status.lastChange.fromBytesPerSecond)} →{" "}
                      {formatLimit(status.lastChange.toBytesPerSecond)}
                      <br />
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                      >
                        {status.lastChange.reason}
                      </Typography>
                    </>
                  )
                  : "None yet"}
              </Fact>
            </Grid>
            <Grid item xs={12} md={4}>
              <Fact label="Next check">
                {enabled && status.decision.nextCheckAt
                  ? formatRelative(status.decision.nextCheckAt, now)
                  : enabled
                  ? "Running"
                  : "Not polling while off"}
              </Fact>
            </Grid>
            <Grid item xs={12} md={4}>
              <Fact label="Last trigger">
                {status.lastTrigger
                  ? (
                    <>
                      {triggerLabels[status.lastTrigger.source]}{" "}
                      {formatRelative(status.lastTrigger.at, now)}
                      <br />
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                      >
                        {status.lastTrigger.detail}
                      </Typography>
                    </>
                  )
                  : "None yet"}
              </Fact>
            </Grid>
            <Grid item xs={12} md={4}>
              <Fact label="Last playback webhook">
                {status.lastWebhook
                  ? (
                    <>
                      {status.lastWebhook.event}, {formatRelative(status.lastWebhook.at, now)}
                      <br />
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                      >
                        {webhookOutcomeLabels[status.lastWebhook.outcome]}
                      </Typography>
                    </>
                  )
                  : "None since the container started"}
              </Fact>
            </Grid>
            <Grid item xs={12} md={4}>
              <Fact label="Webhook → SABnzbd cap">
                <WebhookLatency timing={status.lastWebhookThrottle} now={now} />
              </Fact>
            </Grid>
          </Grid>

          <Divider />

          <Typography variant="subtitle1" component="h3">
            Settings
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <TextField
                  label="Throttled speed"
                  type="number"
                  value={draft.throttleValue}
                  onChange={(event) => setDraft({ ...draft, throttleValue: event.target.value })}
                  error={Boolean(validation.fields.throttleValue)}
                  helperText={validation.fields.throttleValue ??
                    describeDraftRate(draft)}
                  inputProps={{ min: 0, step: "any" }}
                  sx={{ flexGrow: 1 }}
                />
                <FormControl sx={{ minWidth: 170 }}>
                  <InputLabel id="bandwidth-unit-label">Unit</InputLabel>
                  <Select
                    labelId="bandwidth-unit-label"
                    label="Unit"
                    value={draft.throttleUnit}
                    onChange={(event) =>
                      setDraft(
                        convertDraftUnit(
                          draft,
                          event.target.value as ThrottleUnit,
                        ),
                      )}
                  >
                    {(Object.keys(unitLabels) as ThrottleUnit[]).map((unit) => (
                      <MenuItem key={unit} value={unit}>
                        {unitLabels[unit]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <NumberField
                label="Idle check interval"
                value={draft.idlePollIntervalSeconds}
                onChange={(value) => setDraft({ ...draft, idlePollIntervalSeconds: value })}
                error={validation.fields.idlePollIntervalSeconds}
                helperText={idleHelp}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <NumberField
                label="Active check interval"
                value={draft.activePollIntervalSeconds}
                onChange={(value) => setDraft({ ...draft, activePollIntervalSeconds: value })}
                error={validation.fields.activePollIntervalSeconds}
                helperText={activeHelp}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <NumberField
                label="Recovery grace period"
                value={draft.recoveryGraceSeconds}
                onChange={(value) => setDraft({ ...draft, recoveryGraceSeconds: value })}
                error={validation.fields.recoveryGraceSeconds}
                helperText="Wait this long after playback stops before lifting the cap"
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <FormControl fullWidth>
                <InputLabel id="bandwidth-paused-label">
                  Paused streams
                </InputLabel>
                <Select
                  labelId="bandwidth-paused-label"
                  label="Paused streams"
                  value={draft.pausedPolicy}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      pausedPolicy: event.target.value as PausedPolicy,
                    })}
                >
                  {(Object.keys(pausedPolicyLabels) as PausedPolicy[]).map((
                    policy,
                  ) => (
                    <MenuItem key={policy} value={policy}>
                      {pausedPolicyLabels[policy]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <NumberField
                label="Paused grace period"
                value={draft.pausedGraceSeconds}
                disabled={draft.pausedPolicy !== "grace"}
                onChange={(value) => setDraft({ ...draft, pausedGraceSeconds: value })}
                error={validation.fields.pausedGraceSeconds}
                helperText="How long a paused stream still counts"
              />
            </Grid>
          </Grid>

          <Stack
            direction="row"
            spacing={1}
            sx={{ flexWrap: "wrap", rowGap: 1 }}
          >
            <Button
              variant="contained"
              onClick={save}
              disabled={!dirty || Boolean(validation.error) || busy !== null}
            >
              {busy === "save" ? "Saving" : "Save settings"}
            </Button>
            <Button
              variant="text"
              onClick={() => setDraft(baseline)}
              disabled={!dirty || busy !== null}
            >
              Undo changes
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip
              title={enabled
                ? "Check Jellyfin and SABnzbd now and correct SABnzbd's limit if needed"
                : "Automation is off: this only checks Jellyfin and SABnzbd and changes nothing"}
            >
              <span>
                <Button
                  variant="outlined"
                  startIcon={busy === "reconcile" ? <CircularProgress size={16} /> : <SyncIcon />}
                  onClick={reconcile}
                  disabled={busy !== null}
                >
                  Reconcile now
                </Button>
              </span>
            </Tooltip>
          </Stack>

          <Box>
            <Button
              size="small"
              color="inherit"
              onClick={() => setErrorsOpen((open) => !open)}
              startIcon={errorsOpen ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
            >
              Recent errors ({status.recentErrors.length})
            </Button>
            <Collapse in={errorsOpen}>
              {status.recentErrors.length === 0
                ? (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ pl: 1, pt: 1 }}
                  >
                    No errors since the container started.
                  </Typography>
                )
                : (
                  <Stack spacing={1} sx={{ pt: 1 }}>
                    {status.recentErrors.map((entry) => (
                      <Stack
                        key={`${entry.source}-${entry.firstAt}`}
                        direction="row"
                        spacing={1}
                        alignItems="baseline"
                        sx={{ flexWrap: "wrap", rowGap: 0.5 }}
                      >
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label={sourceLabels[entry.source]}
                        />
                        <Typography variant="body2">{entry.message}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {entry.count > 1
                            ? `${entry.count} times, last ${formatRelative(entry.lastAt, now)}`
                            : formatRelative(entry.lastAt, now)}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
            </Collapse>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function PanelTitle() {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box color="primary.main" sx={{ display: "flex" }}>
        <SpeedIcon />
      </Box>
      <Typography variant="h6" component="h2">
        Bandwidth Automation
      </Typography>
    </Stack>
  );
}

function ModeChip({ mode }: { mode: ControllerMode }) {
  switch (mode) {
    case "off":
      return <Chip size="small" label="Off" />;
    case "unrestricted":
      return <Chip size="small" color="success" label="Unrestricted" />;
    case "throttled":
      return <Chip size="small" color="warning" label="Throttled" />;
    case "recovery_grace":
      return <Chip size="small" color="info" label="Recovery grace" />;
    case "protective_error":
      return <Chip size="small" color="error" label="Protective (error)" />;
  }
}

/** Webhook receipt to SABnzbd's acknowledgement, not from when Play was pressed. */
function WebhookLatency(
  { timing, now }: { timing: BandwidthStatus["lastWebhookThrottle"]; now: number },
) {
  if (!timing) {
    return <>No webhook has capped SABnzbd since the container started</>;
  }

  const parts = [
    timing.receivedToRequestMs === null ? null : `${timing.receivedToRequestMs} ms to send`,
    timing.requestMs === null ? null : `${timing.requestMs} ms SABnzbd request`,
    timing.receivedToReconcileMs === null
      ? null
      : `Jellyfin check done at ${timing.receivedToReconcileMs} ms`,
  ].filter(Boolean);

  return (
    <>
      {timing.outcome === "capped" && timing.receivedToAckMs !== null
        ? `${timing.receivedToAckMs} ms`
        : "Failed"} ({timing.event}, {formatRelative(timing.receivedAt, now)})
      <br />
      <Typography component="span" variant="caption" color="text.secondary">
        {parts.join(" · ")}
        {parts.length > 0 ? ". " : ""}
        Measured from when ObservaRR received the webhook; Jellyfin's own delay in sending it isn't
        included.
      </Typography>
    </>
  );
}

function StatTile(
  { label, value, detail }: { label: string; value: string; detail: string },
) {
  return (
    <Box
      sx={{
        height: "100%",
        p: 1.5,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "background.default",
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" component="p" sx={{ fontWeight: 600, my: 0.25 }}>
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {detail}
      </Typography>
    </Box>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Box>
  );
}

function ConnectionChip(
  { name, status, now }: {
    name: string;
    status: ConnectionStatus;
    now: number;
  },
) {
  const label = {
    ok: `${name}: connected`,
    error: `${name}: error`,
    unknown: `${name}: not checked yet`,
    not_configured: `${name}: not configured`,
  }[status.state];
  const title = status.state === "error"
    ? `${status.lastError ?? "Error"} (${formatRelative(status.lastErrorAt, now)})`
    : status.lastSuccessAt
    ? `Last answered ${formatRelative(status.lastSuccessAt, now)}`
    : "";

  return (
    <Tooltip title={title}>
      <Chip
        size="small"
        label={label}
        color={status.state === "ok" ? "success" : status.state === "error" ? "error" : "default"}
        variant={status.state === "ok" || status.state === "error" ? "filled" : "outlined"}
      />
    </Tooltip>
  );
}

function NumberField({
  label,
  value,
  onChange,
  error,
  helperText,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  helperText: string;
  disabled?: boolean;
}) {
  return (
    <TextField
      label={label}
      type="number"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      error={Boolean(error)}
      helperText={error ?? helperText}
      fullWidth
      inputProps={{ min: 0, step: 1 }}
      InputProps={{
        endAdornment: <InputAdornment position="end">s</InputAdornment>,
      }}
    />
  );
}

function settingsToDraft(settings: BandwidthStatus["settings"]): Draft {
  return {
    throttleValue: trimNumber(settings.throttleValue),
    throttleUnit: settings.throttleUnit,
    idlePollIntervalSeconds: String(settings.idlePollIntervalSeconds),
    activePollIntervalSeconds: String(settings.activePollIntervalSeconds),
    recoveryGraceSeconds: String(settings.recoveryGraceSeconds),
    pausedPolicy: settings.pausedPolicy,
    pausedGraceSeconds: String(settings.pausedGraceSeconds),
  };
}

function sameDraft(left: Draft, right: Draft): boolean {
  return left.throttleUnit === right.throttleUnit &&
    left.pausedPolicy === right.pausedPolicy &&
    Number(left.throttleValue) === Number(right.throttleValue) &&
    Number(left.idlePollIntervalSeconds) === Number(right.idlePollIntervalSeconds) &&
    Number(left.activePollIntervalSeconds) === Number(right.activePollIntervalSeconds) &&
    Number(left.recoveryGraceSeconds) === Number(right.recoveryGraceSeconds) &&
    Number(left.pausedGraceSeconds) === Number(right.pausedGraceSeconds);
}

/** Switching units keeps the same speed: 80 Mb/s becomes 10 MB/s. */
function convertDraftUnit(draft: Draft, unit: ThrottleUnit): Draft {
  const value = Number(draft.throttleValue);
  if (
    !Number.isFinite(value) || draft.throttleValue.trim() === "" ||
    unit === draft.throttleUnit
  ) {
    return { ...draft, throttleUnit: unit };
  }

  const bytes = value * bytesPerUnit[draft.throttleUnit];
  return {
    ...draft,
    throttleUnit: unit,
    throttleValue: trimNumber(bytes / bytesPerUnit[unit]),
  };
}

function validateDraft(
  draft: Draft,
): { error: string | null; fields: Partial<Record<keyof Draft, string>> } {
  const fields: Partial<Record<keyof Draft, string>> = {};
  const throttle = Number(draft.throttleValue);

  if (draft.throttleValue.trim() === "" || !Number.isFinite(throttle)) {
    fields.throttleValue = "Enter a speed";
  } else {
    const mbps = (throttle * bytesPerUnit[draft.throttleUnit]) /
      bytesPerUnit.Mbps;
    if (mbps < limits.throttleMbps.min || mbps > limits.throttleMbps.max) {
      fields.throttleValue = "Between 1 and 10,000 Mb/s (0.125 to 1,250 MB/s)";
    }
  }

  for (
    const key of [
      "idlePollIntervalSeconds",
      "activePollIntervalSeconds",
      "recoveryGraceSeconds",
      "pausedGraceSeconds",
    ] as const
  ) {
    const value = Number(draft[key]);
    const { min, max } = limits[key];
    if (
      draft[key].trim() === "" || !Number.isInteger(value) || value < min ||
      value > max
    ) {
      fields[key] = `A whole number from ${min} to ${max}`;
    }
  }

  const first = Object.values(fields)[0];
  return { error: first ?? null, fields };
}

function describeDraftRate(draft: Draft): string {
  const value = Number(draft.throttleValue);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  const bytes = value * bytesPerUnit[draft.throttleUnit];
  const other = draft.throttleUnit === "Mbps" ? formatMBps(bytes) : formatMbps(bytes);
  return `= ${other}. SABnzbd counts in MiB, so it shows ${formatMiBps(bytes)}.`;
}

function describePlayback(
  playback: NonNullable<BandwidthStatus["playback"]>,
): string {
  const parts = [`${playback.playing} playing`];
  if (playback.pendingWebhookStreams > 0) {
    parts.push(`${playback.pendingWebhookStreams} just started (webhook)`);
  }
  if (playback.transcoding > 0) {
    parts.push(`${playback.transcoding} transcoding`);
  }
  if (playback.pausedCounted > 0) {
    parts.push(`${playback.pausedCounted} paused (counted)`);
  }
  if (playback.pausedIgnored > 0) {
    parts.push(`${playback.pausedIgnored} paused (ignored)`);
  }
  if (playback.stale > 0) parts.push(`${playback.stale} stale (ignored)`);
  const idle = playback.totalSessions - playback.streams.length;
  if (idle > 0) parts.push(`${idle} connected, not playing`);
  return parts.join(" · ");
}

function decisionTitle(status: BandwidthStatus): string {
  if (!status.settings.enabled) return "Off";
  switch (status.decision.reason) {
    case "streams_active":
      return "Capped";
    case "playback_started":
      return "Capped (just started)";
    case "grace_period":
      return "Grace period";
    case "idle":
      return "Unrestricted";
    case "jellyfin_unavailable":
      return "Holding cap";
    default:
      return "Starting";
  }
}

function decisionDetail(status: BandwidthStatus, now: number): string {
  if (!status.settings.enabled) {
    return "ObservaRR isn't changing SABnzbd's speed limit.";
  }

  const cap = formatMbps(status.settings.throttleBytesPerSecond);
  switch (status.decision.reason) {
    case "streams_active":
      return `Jellyfin is playing, so SABnzbd is held to ${cap}.`;
    case "playback_started":
      return `A Jellyfin webhook reported playback, so SABnzbd was capped to ${cap} at once. ` +
        "The next check confirms it with Jellyfin.";
    case "grace_period":
      return `Nothing playing. The cap comes off ${
        formatRelative(status.decision.graceUntil, now)
      } unless something starts.`;
    case "idle":
      return "Nothing playing on Jellyfin.";
    case "jellyfin_unavailable":
      return `Jellyfin can't be read, so the protective ${cap} cap stays on.`;
    default:
      return "Waiting for the first check.";
  }
}

function describeOutcome(data: ReconcileResponse): string {
  const { outcome } = data;
  if (outcome.skipped) {
    return "The controller isn't running.";
  }

  const streams = outcome.countedStreams === null
    ? "Jellyfin couldn't be read"
    : `${outcome.countedStreams} active stream${outcome.countedStreams === 1 ? "" : "s"}`;
  const limit = data.sabnzbd.speedLimitBytesPerSecond === null
    ? "SABnzbd couldn't be read"
    : `SABnzbd limit ${formatLimit(data.sabnzbd.speedLimitBytesPerSecond)}`;

  if (outcome.checkOnly) {
    return `Checked (automation is off, nothing changed): ${streams}; ${limit}.`;
  }

  if (outcome.change) {
    return `Reconciled: ${streams}; changed SABnzbd from ${
      formatLimit(outcome.change.fromBytesPerSecond)
    } to ${formatLimit(outcome.change.toBytesPerSecond)}.`;
  }

  return outcome.success
    ? `Reconciled: ${streams}; ${limit}, no change needed.`
    : `Reconcile incomplete: ${streams}; ${limit}. See recent errors.`;
}

function verdictLabel(
  verdict: NonNullable<
    BandwidthStatus["playback"]
  >["streams"][number]["verdict"],
) {
  return {
    playing: "Counts",
    paused_counted: "Paused, counts",
    paused_ignored: "Paused, ignored",
    stale: "Stale, ignored",
  }[verdict];
}

function playMethodLabel(method: string | null): string | null {
  if (!method) return null;
  return {
    DirectPlay: "direct play",
    DirectStream: "direct stream",
    Transcode: "transcode",
  }[method] ??
    method;
}

function formatLimit(bytes: number | null): string {
  if (bytes === null) return "unknown";
  if (bytes <= 0) return "unlimited";
  return `${formatMbps(bytes)} (${formatMBps(bytes)})`;
}

function formatMbps(bytes: number): string {
  return `${trimNumber(bytes / bytesPerUnit.Mbps, 1)} Mb/s`;
}

function formatMBps(bytes: number): string {
  return `${trimNumber(bytes / bytesPerUnit.MBps, 2)} MB/s`;
}

/** What SABnzbd's own UI shows: binary MiB/s, labeled "MB/s". */
function formatMiBps(bytes: number): string {
  return `${trimNumber(bytes / 1_048_576, 2)} "MB/s"`;
}

function trimNumber(value: number, digits = 3): string {
  return String(Number(value.toFixed(digits)));
}

function formatWhen(value: string, now: number): string {
  return `${new Date(value).toLocaleString()} (${formatRelative(value, now)})`;
}

function formatRelative(value: string | null, now: number): string {
  if (!value) return "unknown";
  const seconds = Math.round((Date.parse(value) - now) / 1000);
  const magnitude = Math.abs(seconds);
  const text = magnitude < 60
    ? `${magnitude} s`
    : magnitude < 3600
    ? `${Math.round(magnitude / 60)} min`
    : magnitude < 86_400
    ? `${Math.round(magnitude / 3600)} h`
    : `${Math.round(magnitude / 86_400)} d`;

  if (magnitude <= 1) return "just now";
  return seconds > 0 ? `in ${text}` : `${text} ago`;
}

function errorFrom(text: string): string | null {
  try {
    const data = JSON.parse(text) as { error?: unknown };
    return typeof data.error === "string" ? data.error : null;
  } catch {
    return null;
  }
}
