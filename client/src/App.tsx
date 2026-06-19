import LogoutIcon from "@mui/icons-material/Logout";
import SettingsIcon from "@mui/icons-material/Settings";
import SmsIcon from "@mui/icons-material/Sms";
import StorageIcon from "@mui/icons-material/Storage";
import TuneIcon from "@mui/icons-material/Tune";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Container,
  CssBaseline,
  Drawer,
  FormControlLabel,
  Grid,
  IconButton,
  Stack,
  TextField,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  createTheme,
} from "@mui/material";
import { FormEvent, useEffect, useState } from "react";

type VersionResponse = {
  ok: boolean;
  app: string;
  version: string;
  runtime: string;
  environment: string;
  build: {
    sha: string | null;
    date: string | null;
  };
};

type User = {
  id: number;
  username: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type AuthStatus = {
  ok: boolean;
  hasUsers: boolean;
};

type OverviewResponse = {
  ok: boolean;
  app: string;
  status: string;
  counts: {
    receipts: number;
    profiles: number;
    templates: number;
    users: number;
  };
  providerConfigured: boolean;
};

type EventSourceName =
  | "jellyfin"
  | "seerr"
  | "radarr"
  | "sonarr"
  | "sabnzbd"
  | "system"
  | "test";

type LiveEvent = {
  id: string;
  timestamp: string;
  source: EventSourceName;
  eventType: string;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  entityType?: string;
  entityTitle?: string;
  rawSummary?: Record<string, unknown>;
};

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#1f6f5b",
    },
    background: {
      default: "#f5f7f8",
    },
  },
  shape: {
    borderRadius: 8,
  },
});

function App() {
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [backendStatus, setBackendStatus] = useState<"loading" | "online" | "error">("loading");
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    fetchVersion();
    fetchAuthState();
  }, []);

  useEffect(() => {
    if (!user) {
      setOverview(null);
      return;
    }

    fetch("/api/admin/overview")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Overview returned ${response.status}`);
        }

        return response.json() as Promise<OverviewResponse>;
      })
      .then(setOverview)
      .catch(() => setOverview(null));
  }, [user]);

  function fetchVersion() {
    fetch("/api/version")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Backend returned ${response.status}`);
        }

        return response.json() as Promise<VersionResponse>;
      })
      .then((data) => {
        setVersion(data);
        setBackendStatus("online");
      })
      .catch(() => {
        setBackendStatus("error");
      });
  }

  function fetchAuthState() {
    setAuthLoading(true);

    Promise.all([
      fetch("/api/auth/status").then((response) => response.json() as Promise<AuthStatus>),
      fetch("/api/auth/me"),
    ])
      .then(async ([statusData, meResponse]) => {
        setAuthStatus(statusData);

        if (meResponse.ok) {
          const data = (await meResponse.json()) as { ok: boolean; user: User };
          setUser(data.user);
        } else {
          setUser(null);
        }
      })
      .finally(() => setAuthLoading(false));
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError(null);
    setLoginLoading(true);

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") || "");
    const password = String(formData.get("password") || "");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Login failed");
      }

      setUser(data.user);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setOverview(null);
    fetchAuthState();
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
        <AppBar position="static" elevation={0}>
          <Toolbar>
            <Typography variant="h6" component="h1" sx={{ fontWeight: 700, flexGrow: 1 }}>
              SMS Gateway
            </Typography>
            {user && (
              <Stack direction="row" spacing={1} alignItems="center">
                <Button color="inherit" size="small" onClick={() => setProfileOpen(true)}>
                  {user.username}
                </Button>
                <Tooltip title="Log out">
                  <IconButton color="inherit" onClick={handleLogout} aria-label="Log out">
                    <LogoutIcon />
                  </IconButton>
                </Tooltip>
              </Stack>
            )}
          </Toolbar>
        </AppBar>

        {authLoading ? (
          <Stack alignItems="center" justifyContent="center" sx={{ minHeight: "70vh" }}>
            <CircularProgress />
          </Stack>
        ) : user ? (
          <Dashboard version={version} status={backendStatus} overview={overview} />
        ) : (
          <LoginScreen
            authStatus={authStatus}
            error={loginError}
            loading={loginLoading}
            onSubmit={handleLogin}
          />
        )}
        {user && (
          <ProfileDrawer
            user={user}
            open={profileOpen}
            onClose={() => setProfileOpen(false)}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}

function ProfileDrawer({
  user,
  open,
  onClose,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters");
      return;
    }

    setSaving(true);

    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Password update failed");
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Password updated");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Password update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width: { xs: 320, sm: 380 }, p: 3 }}>
        <Stack spacing={3}>
          <Stack spacing={0.5}>
            <Typography variant="h6" component="h2">
              Profile
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Local admin account
            </Typography>
          </Stack>

          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Username
            </Typography>
            <Typography>{user.username}</Typography>
            <Typography variant="body2" color="text.secondary">
              Role
            </Typography>
            <Typography>{user.role}</Typography>
            <Typography variant="body2" color="text.secondary">
              Last login
            </Typography>
            <Typography>
              {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Not recorded"}
            </Typography>
          </Stack>

          <Stack component="form" spacing={2} onSubmit={handlePasswordSubmit}>
            <Typography variant="subtitle1" component="h3">
              Change password
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">{success}</Alert>}
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              fullWidth
            />
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              fullWidth
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              fullWidth
            />
            <Button type="submit" variant="contained" disabled={saving}>
              {saving ? "Updating" : "Update password"}
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Drawer>
  );
}

function LoginScreen({
  authStatus,
  error,
  loading,
  onSubmit,
}: {
  authStatus: AuthStatus | null;
  error: string | null;
  loading: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack component="form" spacing={3} onSubmit={onSubmit}>
            <Stack spacing={1}>
              <Typography variant="h5" component="h2">
                Admin login
              </Typography>
              <Typography color="text.secondary">
                Sign in with the local admin account for this container.
              </Typography>
            </Stack>

            {authStatus && !authStatus.hasUsers && (
              <Alert severity="warning">
                No admin user has been bootstrapped. Set ADMIN_PASSWORD and restart the container.
              </Alert>
            )}

            {error && <Alert severity="error">{error}</Alert>}

            <TextField name="username" label="Username" autoComplete="username" required fullWidth />
            <TextField
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              fullWidth
            />
            <Button type="submit" variant="contained" disabled={loading} fullWidth>
              {loading ? "Signing in" : "Sign in"}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}

function Dashboard({
  version,
  status,
  overview,
}: {
  version: VersionResponse | null;
  status: "loading" | "online" | "error";
  overview: OverviewResponse | null;
}) {
  const placeholders = [
    {
      title: "Message Receipts",
      body: `${overview?.counts.receipts ?? 0} receipts stored.`,
      icon: <StorageIcon />,
    },
    {
      title: "Notification Profiles",
      body: `${overview?.counts.profiles ?? 0} profiles configured.`,
      icon: <TuneIcon />,
    },
    {
      title: "Event Templates",
      body: `${overview?.counts.templates ?? 0} templates configured.`,
      icon: <SmsIcon />,
    },
    {
      title: "Provider Settings",
      body: overview?.providerConfigured
        ? "Twilio environment placeholders are configured."
        : "Twilio environment placeholders are incomplete.",
      icon: <SettingsIcon />,
    },
  ];

  return (
    <>
      <Container maxWidth="lg" sx={{ py: 4, pb: 10 }}>
        <Grid container spacing={3}>
          <Grid item xs={12} md={7}>
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={2}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h5" component="h2">
                      Admin panel online
                    </Typography>
                    <Chip
                      size="small"
                      label={status === "online" ? "Backend online" : status}
                      color={status === "online" ? "success" : status === "error" ? "error" : "default"}
                    />
                  </Stack>
                  <Typography color="text.secondary">
                    Internal dashboard for webhook status, provider configuration, and future notification controls.
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={5}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" component="h2" gutterBottom>
                  Backend Status
                </Typography>
                <Stack spacing={1}>
                  <Typography variant="body2" color="text.secondary">
                    App: {version?.app ?? "Loading"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Version: {version?.version ?? "Loading"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Runtime: {version?.runtime ?? "Loading"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Environment: {version?.environment ?? "Loading"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Users: {overview?.counts.users ?? 0}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          {placeholders.map((item) => (
            <Grid key={item.title} item xs={12} sm={6} md={3}>
              <Card variant="outlined" sx={{ height: "100%" }}>
                <CardContent>
                  <Stack spacing={2}>
                    <Box color="primary.main">{item.icon}</Box>
                    <Typography variant="h6" component="h2">
                      {item.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {item.body}
                    </Typography>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>
      <EventConsole />
    </>
  );
}

const sourceOptions: Array<{ label: string; value: EventSourceName[]; key: string }> = [
  { label: "Jellyfin", value: ["jellyfin"], key: "jellyfin" },
  { label: "Seerr", value: ["seerr"], key: "seerr" },
  { label: "Radarr", value: ["radarr"], key: "radarr" },
  { label: "Sonarr", value: ["sonarr"], key: "sonarr" },
  { label: "SABnzbd", value: ["sabnzbd"], key: "sabnzbd" },
  { label: "System/Test", value: ["system", "test"], key: "system-test" },
];

const sourceColors: Record<EventSourceName, string> = {
  jellyfin: "#22d3ee",
  seerr: "#c084fc",
  radarr: "#fb923c",
  sonarr: "#4ade80",
  sabnzbd: "#facc15",
  system: "#9ca3af",
  test: "#9ca3af",
};

const sourceLabels: Record<EventSourceName, string> = {
  jellyfin: "Jellyfin",
  seerr: "Seerr",
  radarr: "Radarr",
  sonarr: "Sonarr",
  sabnzbd: "SABnzbd",
  system: "System",
  test: "Test",
};

function EventConsole() {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "disconnected">("connecting");
  const [enabledSources, setEnabledSources] = useState<Record<string, boolean>>(() => {
    const saved = localStorage.getItem("sms-gateway:event-console-filters");

    if (saved) {
      try {
        return JSON.parse(saved) as Record<string, boolean>;
      } catch {
        localStorage.removeItem("sms-gateway:event-console-filters");
      }
    }

    return Object.fromEntries(sourceOptions.map((option) => [option.key, true]));
  });

  useEffect(() => {
    fetch("/api/events/recent")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Events returned ${response.status}`);
        }

        return response.json() as Promise<{ ok: boolean; events: LiveEvent[] }>;
      })
      .then((data) => setEvents(data.events.slice(-300)))
      .catch(() => setStatus("disconnected"));

    const source = new EventSource("/api/events/stream");
    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus("disconnected");
    source.onmessage = (event) => {
      const liveEvent = JSON.parse(event.data) as LiveEvent;
      setEvents((current) => [...current, liveEvent].slice(-300));
      setStatus("live");
    };

    return () => source.close();
  }, []);

  useEffect(() => {
    localStorage.setItem("sms-gateway:event-console-filters", JSON.stringify(enabledSources));
  }, [enabledSources]);

  const allowedSources = new Set(
    sourceOptions.flatMap((option) => enabledSources[option.key] ? option.value : []),
  );
  const filteredEvents = events.filter((event) => allowedSources.has(event.source));

  function toggleFilter(key: string) {
    setEnabledSources((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  return (
    <Box
      sx={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: (muiTheme) => muiTheme.zIndex.drawer + 1,
        bgcolor: "#0b1120",
        color: "#d1d5db",
        borderTop: "1px solid #1f2937",
        boxShadow: "0 -8px 24px rgba(15, 23, 42, 0.35)",
      }}
    >
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        onClick={() => setExpanded((value) => !value)}
        sx={{
          height: 44,
          px: 2,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <Typography sx={{ fontFamily: "monospace", fontWeight: 700 }}>
          Event Console
        </Typography>
        <Chip
          size="small"
          label={`${events.length} recent`}
          sx={{ bgcolor: "#111827", color: "#d1d5db" }}
        />
        <Chip
          size="small"
          label={status}
          color={status === "live" ? "success" : status === "connecting" ? "warning" : "error"}
          variant="outlined"
        />
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" sx={{ color: "#d1d5db" }}>
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </Stack>

      {expanded && (
        <Box sx={{ height: { xs: 360, md: 420 }, borderTop: "1px solid #1f2937" }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{ px: 2, py: 1, flexWrap: "wrap", gap: 1 }}
            alignItems="center"
          >
            {sourceOptions.map((option) => (
              <FormControlLabel
                key={option.key}
                control={
                  <Checkbox
                    size="small"
                    checked={enabledSources[option.key] ?? true}
                    onChange={() => toggleFilter(option.key)}
                    sx={{ color: "#9ca3af", p: 0.5 }}
                  />
                }
                label={option.label}
                sx={{
                  m: 0,
                  color: "#d1d5db",
                  ".MuiFormControlLabel-label": {
                    fontSize: 13,
                    fontFamily: "monospace",
                  },
                }}
              />
            ))}
          </Stack>
          <Box
            sx={{
              height: "calc(100% - 49px)",
              overflowY: "auto",
              px: 2,
              pb: 2,
              fontFamily: "monospace",
              fontSize: 13,
            }}
          >
            {filteredEvents.length === 0 ? (
              <Typography sx={{ color: "#6b7280", fontFamily: "monospace", py: 2 }}>
                No events in the current filter.
              </Typography>
            ) : (
              filteredEvents.map((event) => <EventRow key={event.id} event={event} />)
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function EventRow({ event }: { event: LiveEvent }) {
  const sourceColor = sourceColors[event.source];
  const severityColor = event.severity === "error" ? "#f87171" : sourceColor;

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="baseline"
      sx={{
        py: 0.75,
        borderBottom: "1px solid rgba(31, 41, 55, 0.75)",
        color: "#d1d5db",
      }}
    >
      <Typography sx={{ color: "#6b7280", minWidth: 82, fontFamily: "monospace", fontSize: 12 }}>
        {new Date(event.timestamp).toLocaleTimeString()}
      </Typography>
      <Typography
        sx={{
          color: sourceColor,
          border: `1px solid ${sourceColor}`,
          borderRadius: 1,
          px: 0.75,
          minWidth: 74,
          textAlign: "center",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        {sourceLabels[event.source]}
      </Typography>
      <Typography sx={{ color: severityColor, minWidth: 92, fontFamily: "monospace", fontSize: 12 }}>
        {event.eventType}
      </Typography>
      <Typography sx={{ color: "#f9fafb", fontFamily: "monospace", fontSize: 13 }}>
        {event.title}
        {event.message ? ` - ${event.message}` : ""}
      </Typography>
    </Stack>
  );
}

export default App;
