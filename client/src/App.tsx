import LogoutIcon from "@mui/icons-material/Logout";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import TimelineIcon from "@mui/icons-material/Timeline";
import SettingsIcon from "@mui/icons-material/Settings";
import SmsIcon from "@mui/icons-material/Sms";
import StorageIcon from "@mui/icons-material/Storage";
import TuneIcon from "@mui/icons-material/Tune";
import { MessageReceiptsManager } from "./MessageReceiptsManager";
import {
  NotificationProfilesActions,
  NotificationProfilesManager,
} from "./NotificationProfilesManager";
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
  createTheme,
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
} from "@mui/material";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react";

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
    mediaTimelines: number;
  };
  providerConfigured: boolean;
  providerStatus: {
    notificationsEnabled: boolean;
    smsProvider: string;
    textbeltKeyConfigured: boolean;
    textbeltSenderConfigured: boolean;
    emailConfigured: boolean;
  };
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
  rawPayload?: unknown;
};

type MediaTimeline = {
  id: number;
  mediaKey: string;
  mediaType: string | null;
  title: string;
  thumbnailUrl: string | null;
  source: string | null;
  status: string;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
};

type MediaTimelineEvent = {
  id: number;
  mediaItemId: number;
  liveEventId: string | null;
  timestamp: string;
  source: EventSourceName;
  eventType: string;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  rawPayload: unknown;
  createdAt: string;
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
  const [page, setPage] = useState<"dashboard" | "media-timelines">("dashboard");
  const [selectedMediaTimelineId, setSelectedMediaTimelineId] = useState<number | null>(null);
  const [notificationProfilesOpen, setNotificationProfilesOpen] = useState(false);
  const [messageReceiptsOpen, setMessageReceiptsOpen] = useState(false);
  const [overviewRefreshKey, setOverviewRefreshKey] = useState(0);

  useEffect(() => {
    fetchVersion();
    fetchAuthState();
  }, []);

  useEffect(() => {
    if (!user) {
      setOverview(null);
      return;
    }

    let cancelled = false;

    function refreshOverview() {
      fetch("/api/admin/overview")
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Overview returned ${response.status}`);
          }

          return response.json() as Promise<OverviewResponse>;
        })
        .then((data) => {
          if (!cancelled) {
            setOverview(data);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setOverview(null);
          }
        });
    }

    refreshOverview();
    const interval = window.setInterval(refreshOverview, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user, overviewRefreshKey]);

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

  function openMediaTimeline(id: number | null) {
    setSelectedMediaTimelineId(id);
    setPage("media-timelines");
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
        <AppBar position="static" elevation={0}>
          <Toolbar>
            <Typography variant="h6" component="h1" sx={{ fontWeight: 700, flexGrow: 1 }}>
              ObservaRR
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

        {authLoading
          ? (
            <Stack alignItems="center" justifyContent="center" sx={{ minHeight: "70vh" }}>
              <CircularProgress />
            </Stack>
          )
          : user && page === "media-timelines"
          ? (
            <MediaTimelinesPage
              selectedMediaId={selectedMediaTimelineId}
              onSelectMedia={setSelectedMediaTimelineId}
              onBack={() => setPage("dashboard")}
            />
          )
          : user
          ? (
            <Dashboard
              version={version}
              status={backendStatus}
              overview={overview}
              onOpenMediaTimeline={openMediaTimeline}
              onManageMessageReceipts={() => setMessageReceiptsOpen(true)}
              onManageNotificationProfiles={() => setNotificationProfilesOpen(true)}
              onNotificationProfilesChanged={() => setOverviewRefreshKey((value) => value + 1)}
            />
          )
          : (
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
        {user && (
          <MessageReceiptsManager
            open={messageReceiptsOpen}
            onClose={() => setMessageReceiptsOpen(false)}
          />
        )}
        {user && (
          <NotificationProfilesManager
            open={notificationProfilesOpen}
            profileCount={overview?.counts.profiles ?? 0}
            onClose={() => setNotificationProfilesOpen(false)}
            onChanged={() => setOverviewRefreshKey((value) => value + 1)}
            onOpenMediaTimeline={(id) => {
              setNotificationProfilesOpen(false);
              openMediaTimeline(id);
            }}
          />
        )}
        {user && <EventConsole onOpenMediaTimeline={openMediaTimeline} />}
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

    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters");
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

            <TextField
              name="username"
              label="Username"
              autoComplete="username"
              required
              fullWidth
            />
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
  onOpenMediaTimeline,
  onManageMessageReceipts,
  onManageNotificationProfiles,
  onNotificationProfilesChanged,
}: {
  version: VersionResponse | null;
  status: "loading" | "online" | "error";
  overview: OverviewResponse | null;
  onOpenMediaTimeline: (id: number | null) => void;
  onManageMessageReceipts: () => void;
  onManageNotificationProfiles: () => void;
  onNotificationProfilesChanged: () => void;
}) {
  const placeholders = [
    {
      title: "Media Timelines",
      body: `${overview?.counts.mediaTimelines ?? 0} media timelines.`,
      icon: <TimelineIcon />,
      action: () => onOpenMediaTimeline(null),
    },
    {
      title: "Message Receipts",
      body: `${overview?.counts.receipts ?? 0} receipts stored.`,
      icon: <StorageIcon />,
      action: onManageMessageReceipts,
      actionLabel: "Open Receipts",
    },
    {
      title: "Notification Profiles",
      body: `${overview?.counts.profiles ?? 0} profiles configured.`,
      icon: <TuneIcon />,
      profileActions: true,
    },
    {
      title: "Event Templates",
      body: `${overview?.counts.templates ?? 0} templates configured.`,
      icon: <SmsIcon />,
    },
    {
      title: "Provider Settings",
      body: overview?.providerStatus
        ? `Textbelt SMS ${
          overview.providerStatus.textbeltKeyConfigured ? "key configured" : "key missing"
        }. Notifications ${
          overview.providerStatus.notificationsEnabled ? "enabled" : "disabled"
        }. Email not configured.`
        : "Textbelt SMS status loading. Email not configured.",
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
                      color={status === "online"
                        ? "success"
                        : status === "error"
                        ? "error"
                        : "default"}
                    />
                  </Stack>
                  <Typography color="text.secondary">
                    Internal dashboard for webhook status, provider configuration, and future
                    notification controls.
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
                    {"profileActions" in item && item.profileActions
                      ? (
                        <NotificationProfilesActions
                          count={overview?.counts.profiles ?? 0}
                          onManage={onManageNotificationProfiles}
                          onImported={onNotificationProfilesChanged}
                        />
                      )
                      : (
                        <Typography variant="body2" color="text.secondary">
                          {item.body}
                        </Typography>
                      )}
                    {"action" in item && item.action && (
                      <Button size="small" variant="outlined" onClick={item.action}>
                        {"actionLabel" in item ? item.actionLabel : "Open"}
                      </Button>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>
    </>
  );
}

function MediaTimelinesPage({
  selectedMediaId,
  onSelectMedia,
  onBack,
}: {
  selectedMediaId: number | null;
  onSelectMedia: (id: number | null) => void;
  onBack: () => void;
}) {
  const [items, setItems] = useState<MediaTimeline[]>([]);
  const [selected, setSelected] = useState<MediaTimeline | null>(null);
  const [events, setEvents] = useState<MediaTimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function refreshItems() {
      fetch("/api/media-timelines")
        .then((response) => response.json() as Promise<{ ok: boolean; media: MediaTimeline[] }>)
        .then((data) => {
          if (cancelled) {
            return;
          }

          setItems(data.media);

          if (!selectedMediaId && data.media[0]) {
            onSelectMedia(data.media[0].id);
          }

          if (selectedMediaId && !data.media.some((item) => item.id === selectedMediaId)) {
            onSelectMedia(data.media[0]?.id ?? null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }

    refreshItems();
    const interval = window.setInterval(refreshItems, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [onSelectMedia, selectedMediaId]);

  useEffect(() => {
    if (!selectedMediaId) {
      setSelected(null);
      setEvents([]);
      return;
    }

    let cancelled = false;

    function refreshSelectedTimeline() {
      fetch(`/api/media-timelines/${selectedMediaId}`)
        .then((response) =>
          response.json() as Promise<{
            ok: boolean;
            media: MediaTimeline;
            events: MediaTimelineEvent[];
          }>
        )
        .then((data) => {
          if (!cancelled) {
            setSelected(data.media);
            setEvents(data.events);
          }
        });
    }

    refreshSelectedTimeline();
    const interval = window.setInterval(refreshSelectedTimeline, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedMediaId]);

  const filteredItems = items.filter((item) =>
    `${item.title} ${item.mediaType ?? ""} ${item.source ?? ""}`.toLowerCase().includes(
      search.toLowerCase(),
    )
  );
  const sortedEvents = [...events].sort((left, right) =>
    Date.parse(left.timestamp) - Date.parse(right.timestamp)
  );
  const filteredIds = filteredItems.map((item) => item.id);
  const allFilteredSelected = filteredIds.length > 0 &&
    filteredIds.every((id) => selectedIds.includes(id));

  function toggleSelected(id: number) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((currentId) => currentId !== id) : [...current, id]
    );
  }

  function toggleAllFiltered() {
    setSelectedIds((current) => {
      if (allFilteredSelected) {
        return current.filter((id) => !filteredIds.includes(id));
      }

      return [...new Set([...current, ...filteredIds])];
    });
  }

  async function deleteSelected() {
    if (selectedIds.length === 0) {
      return;
    }

    setDeleting(true);

    try {
      const response = await fetch("/api/media-timelines", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (!response.ok) {
        throw new Error("Delete failed");
      }

      const remaining = items.filter((item) => !selectedIds.includes(item.id));
      setItems(remaining);
      setSelectedIds([]);

      if (selectedMediaId && selectedIds.includes(selectedMediaId)) {
        onSelectMedia(remaining[0]?.id ?? null);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Button variant="outlined" onClick={onBack}>
            Back
          </Button>
          <Box>
            <Typography variant="h5" component="h2">
              Media Timelines
            </Typography>
            <Typography color="text.secondary">
              Persistent timelines automatically identified from live webhook events.
            </Typography>
          </Box>
        </Stack>

        {loading ? <CircularProgress /> : items.length === 0
          ? (
            <Alert severity="info">
              No media timelines yet. Send a media webhook event and it will appear here
              automatically.
            </Alert>
          )
          : (
            <Stack spacing={3}>
              <Grid container spacing={3}>
                <Grid item xs={12} md={4}>
                  <Card variant="outlined" sx={{ height: 560 }}>
                    <CardContent sx={{ height: "100%" }}>
                      <Stack spacing={2} sx={{ height: "100%" }}>
                        <TextField
                          size="small"
                          label="Search media timelines"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                          fullWidth
                        />
                        <Stack direction="row" spacing={1} alignItems="center">
                          <FormControlLabel
                            control={
                              <Checkbox
                                size="small"
                                checked={allFilteredSelected}
                                indeterminate={selectedIds.length > 0 && !allFilteredSelected}
                                onChange={toggleAllFiltered}
                              />
                            }
                            label="Select visible"
                            sx={{ flexGrow: 1 }}
                          />
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            disabled={selectedIds.length === 0 || deleting}
                            onClick={deleteSelected}
                          >
                            Delete {selectedIds.length || ""}
                          </Button>
                        </Stack>
                        <Stack spacing={1} sx={{ overflowY: "auto", pr: 0.5 }}>
                          {filteredItems.map((item) => (
                            <Card
                              key={item.id}
                              variant="outlined"
                              onClick={() => onSelectMedia(item.id)}
                              sx={{
                                cursor: "pointer",
                                borderColor: item.id === selectedMediaId
                                  ? "primary.main"
                                  : undefined,
                                bgcolor: item.id === selectedMediaId
                                  ? "action.selected"
                                  : undefined,
                              }}
                            >
                              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                                <Stack direction="row" spacing={1.5} alignItems="center">
                                  <Checkbox
                                    size="small"
                                    checked={selectedIds.includes(item.id)}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={() => toggleSelected(item.id)}
                                    sx={{ p: 0 }}
                                  />
                                  <MediaThumbnail item={item} />
                                  <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                                    <Typography variant="subtitle1" noWrap>
                                      {item.title}
                                    </Typography>
                                    <Typography variant="body2" color="text.secondary">
                                      {item.mediaType ?? "media"} · {item.eventCount} events
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" noWrap>
                                      Last: {item.lastEventAt
                                        ? new Date(item.lastEventAt).toLocaleString()
                                        : "None"}
                                    </Typography>
                                  </Stack>
                                </Stack>
                              </CardContent>
                            </Card>
                          ))}
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>
                </Grid>

                <Grid item xs={12} md={8}>
                  {selected
                    ? <MediaTimelineEventList media={selected} events={sortedEvents} />
                    : <Alert severity="info">Select a media timeline.</Alert>}
                </Grid>
              </Grid>

              {selected && (
                <Grid container spacing={3}>
                  <Grid item xs={12}>
                    <MediaTimelineGraph media={selected} events={sortedEvents} />
                  </Grid>
                </Grid>
              )}
            </Stack>
          )}
      </Stack>
    </Container>
  );
}

function MediaThumbnail({ item }: { item: MediaTimeline }) {
  const [failed, setFailed] = useState(false);
  const label = item.title.trim().charAt(0).toUpperCase() || "?";

  if (item.thumbnailUrl && !failed) {
    return (
      <Box
        component="img"
        src={item.thumbnailUrl}
        alt=""
        onError={() => setFailed(true)}
        sx={{
          width: 48,
          height: 64,
          borderRadius: 1,
          objectFit: "cover",
          bgcolor: "grey.100",
          border: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <Box
      sx={{
        width: 48,
        height: 64,
        borderRadius: 1,
        bgcolor: "primary.main",
        color: "primary.contrastText",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {label}
    </Box>
  );
}

function MediaTimelineEventList({
  media,
  events,
}: {
  media: MediaTimeline;
  events: MediaTimelineEvent[];
}) {
  return (
    <Card variant="outlined" sx={{ height: 560 }}>
      <CardContent>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="h6" component="h3">
              {media.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {media.mediaType ?? "media"} · {media.status} · {events.length} persisted events
            </Typography>
          </Stack>

          {events.length === 0
            ? <Alert severity="info">No timeline events have been captured yet.</Alert>
            : (
              <Stack spacing={0} sx={{ maxHeight: 450, overflowY: "auto", pr: 1 }}>
                {events.map((event, index) => {
                  const previous = events[index - 1];
                  const gapMs = previous
                    ? Date.parse(event.timestamp) - Date.parse(previous.timestamp)
                    : 0;

                  return (
                    <Box key={event.id}>
                      {previous && (
                        <Typography
                          variant="caption"
                          color={gapMs > 10 * 60 * 1000 ? "warning.main" : "text.secondary"}
                          sx={{ display: "block", ml: 5, my: 1 }}
                        >
                          Gap: {formatDuration(gapMs)}
                        </Typography>
                      )}
                      <Stack direction="row" spacing={2} alignItems="flex-start">
                        <Box
                          sx={{
                            width: 14,
                            height: 14,
                            borderRadius: "50%",
                            bgcolor: sourceColors[event.source] ?? "grey.500",
                            mt: 0.5,
                            flexShrink: 0,
                          }}
                        />
                        <Box
                          sx={{
                            flexGrow: 1,
                            pb: 2,
                            borderBottom: "1px solid",
                            borderColor: "divider",
                          }}
                        >
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ flexWrap: "wrap" }}
                          >
                            <Chip size="small" label={sourceLabels[event.source] ?? event.source} />
                            <Chip size="small" label={event.eventType} variant="outlined" />
                            <Typography variant="caption" color="text.secondary">
                              {new Date(event.timestamp).toLocaleString()}
                            </Typography>
                          </Stack>
                          <Typography sx={{ mt: 1 }}>{event.title}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            {event.message}
                          </Typography>
                        </Box>
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>
            )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function MediaTimelineGraph({
  media,
  events,
}: {
  media: MediaTimeline;
  events: MediaTimelineEvent[];
}) {
  if (events.length === 0) {
    return null;
  }

  const start = Date.parse(events[0].timestamp);
  const end = Date.parse(events[events.length - 1].timestamp);
  const axisPaddingPercent = 3;
  const axisStart = start;
  const axisEnd = Math.max(end, start + 30000);
  const axisSpan = axisEnd - axisStart;

  function eventPosition(timestamp: string): number {
    if (events.length === 1) {
      return 50;
    }

    const raw = ((Date.parse(timestamp) - axisStart) / axisSpan) * 100;
    return axisPaddingPercent + (raw * (100 - axisPaddingPercent * 2)) / 100;
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="baseline" spacing={1}>
            <Typography variant="h6" component="h3">
              Timeline Graph
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {media.title} · end-to-end {formatDuration(Math.max(0, end - start))}
            </Typography>
          </Stack>
          <Box sx={{ position: "relative", height: 210, mx: 1, mt: 2, overflow: "hidden" }}>
            <Box
              sx={{
                position: "absolute",
                left: `${axisPaddingPercent}%`,
                right: `${axisPaddingPercent}%`,
                top: 62,
                height: 3,
                bgcolor: "divider",
              }}
            />
            {events.map((event, index) => {
              const percent = eventPosition(event.timestamp);
              const previous = events[index - 1];
              const gapMs = previous
                ? Date.parse(event.timestamp) - Date.parse(previous.timestamp)
                : 0;

              return (
                <Tooltip
                  key={event.id}
                  arrow
                  title={
                    <Stack spacing={0.5}>
                      <Typography variant="caption">
                        {new Date(event.timestamp).toLocaleString()}
                      </Typography>
                      <Typography variant="body2">
                        {sourceLabels[event.source]} · {event.eventType}
                      </Typography>
                      <Typography variant="body2">{event.title}</Typography>
                      <Typography variant="caption">{event.message}</Typography>
                      {previous && (
                        <Typography variant="caption">
                          Since previous: {formatDuration(gapMs)}
                        </Typography>
                      )}
                    </Stack>
                  }
                >
                  <Box
                    component="span"
                    sx={{
                      position: "absolute",
                      left: `${percent}%`,
                      top: 50,
                      transform: "translateX(-50%)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 0.75,
                    }}
                  >
                    <Box
                      sx={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        bgcolor: sourceColors[event.source] ?? "grey.500",
                        border: event.severity === "error"
                          ? "3px solid #ef4444"
                          : "3px solid white",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        whiteSpace: "nowrap",
                        transform: index % 2 === 0 ? "translateY(0)" : "translateY(24px)",
                        textAlign: "center",
                      }}
                    >
                      {sourceLabels[event.source]}
                      <br />
                      {new Date(event.timestamp).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </Typography>
                  </Box>
                </Tooltip>
              );
            })}
          </Box>
          <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", gap: 1 }}>
            {Object.entries(sourceLabels)
              .filter(([source]) => events.some((event) => event.source === source))
              .map(([source, label]) => (
                <Stack key={source} direction="row" spacing={0.75} alignItems="center">
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      bgcolor: sourceColors[source as EventSourceName],
                    }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                </Stack>
              ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
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

function EventConsole({
  onOpenMediaTimeline,
}: {
  onOpenMediaTimeline: (id: number | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(() => {
    const savedHeight = Number(localStorage.getItem("observarr:event-console-height"));
    return Number.isFinite(savedHeight) && savedHeight >= 260 ? savedHeight : 420;
  });
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "disconnected">("connecting");
  const [enabledSources, setEnabledSources] = useState<Record<string, boolean>>(() => {
    const saved = localStorage.getItem("observarr:event-console-filters");

    if (saved) {
      try {
        return JSON.parse(saved) as Record<string, boolean>;
      } catch {
        localStorage.removeItem("observarr:event-console-filters");
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
    localStorage.setItem("observarr:event-console-filters", JSON.stringify(enabledSources));
  }, [enabledSources]);

  useEffect(() => {
    localStorage.setItem("observarr:event-console-height", String(drawerHeight));
  }, [drawerHeight]);

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

  function clearVisibleEvents(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setEvents([]);
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startY = event.clientY;
    const startHeight = drawerHeight;
    const maxHeight = Math.max(260, window.innerHeight - 72);

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextHeight = Math.min(
        maxHeight,
        Math.max(260, startHeight + startY - moveEvent.clientY),
      );
      setDrawerHeight(nextHeight);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
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
        <Button size="small" sx={{ color: "#d1d5db" }} onClick={clearVisibleEvents}>
          Clear
        </Button>
        <Button size="small" sx={{ color: "#d1d5db" }}>
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </Stack>

      {expanded && (
        <Box sx={{ height: drawerHeight, borderTop: "1px solid #1f2937", position: "relative" }}>
          <Box
            onPointerDown={handleResizeStart}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize Event Console"
            sx={{
              position: "absolute",
              top: -5,
              left: 0,
              right: 0,
              height: 10,
              cursor: "ns-resize",
              zIndex: 1,
              "&::after": {
                content: '""',
                position: "absolute",
                top: 4,
                left: "50%",
                width: 72,
                height: 3,
                borderRadius: 999,
                bgcolor: "#4b5563",
                transform: "translateX(-50%)",
              },
            }}
          />
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
            {filteredEvents.length === 0
              ? (
                <Typography sx={{ color: "#6b7280", fontFamily: "monospace", py: 2 }}>
                  No events in the current filter.
                </Typography>
              )
              : (
                filteredEvents.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    onOpenMediaTimeline={onOpenMediaTimeline}
                  />
                ))
              )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function EventRow({
  event,
  onOpenMediaTimeline,
}: {
  event: LiveEvent;
  onOpenMediaTimeline: (id: number | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openingTimeline, setOpeningTimeline] = useState(false);
  const [mediaTimelineId, setMediaTimelineId] = useState<number | null>(null);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [payloadHeight, setPayloadHeight] = useState(() => {
    const savedHeight = Number(localStorage.getItem("observarr:event-payload-height"));
    return Number.isFinite(savedHeight) && savedHeight >= 120 ? savedHeight : 220;
  });
  const sourceColor = sourceColors[event.source];
  const severityColor = event.severity === "error" ? "#f87171" : sourceColor;
  const rawDetails = event.rawPayload ?? event.rawSummary;
  const hasRawDetails = rawDetails !== undefined && rawDetails !== null;

  useEffect(() => {
    localStorage.setItem("observarr:event-payload-height", String(payloadHeight));
  }, [payloadHeight]);

  function handlePayloadResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startY = event.clientY;
    const startHeight = payloadHeight;
    const maxHeight = Math.max(160, window.innerHeight - 180);

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextHeight = Math.min(
        maxHeight,
        Math.max(120, startHeight + moveEvent.clientY - startY),
      );
      setPayloadHeight(nextHeight);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  async function handleOpenMediaTimeline(clickEvent: ReactMouseEvent<HTMLButtonElement>) {
    clickEvent.stopPropagation();
    setOpeningTimeline(true);
    setTrackError(null);

    try {
      const response = await fetch("/api/media-timelines/from-event", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ eventId: event.id }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not find media timeline");
      }

      setMediaTimelineId(data.media.id);
      onOpenMediaTimeline(data.media.id);
    } catch (caughtError) {
      setTrackError(
        caughtError instanceof Error ? caughtError.message : "Could not find media timeline",
      );
    } finally {
      setOpeningTimeline(false);
    }
  }

  return (
    <Box
      sx={{
        borderBottom: "1px solid rgba(31, 41, 55, 0.75)",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="baseline"
        sx={{
          py: 0.75,
          color: "#d1d5db",
        }}
      >
        <IconButton
          size="small"
          onClick={() => setExpanded((value) => !value)}
          disabled={!hasRawDetails}
          aria-label={expanded ? "Collapse event details" : "Expand event details"}
          sx={{ color: hasRawDetails ? "#9ca3af" : "#374151", p: 0.25 }}
        >
          {expanded
            ? <KeyboardArrowDownIcon fontSize="small" />
            : <KeyboardArrowRightIcon fontSize="small" />}
        </IconButton>
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
        <Typography
          sx={{ color: severityColor, minWidth: 92, fontFamily: "monospace", fontSize: 12 }}
        >
          {event.eventType}
        </Typography>
        <Typography sx={{ color: "#f9fafb", fontFamily: "monospace", fontSize: 13 }}>
          {event.title}
          {event.message ? ` - ${event.message}` : ""}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {mediaTimelineId
          ? (
            <Button
              size="small"
              onClick={(clickEvent) => {
                clickEvent.stopPropagation();
                onOpenMediaTimeline(mediaTimelineId);
              }}
              sx={{ color: "#d1d5db", minWidth: 112 }}
            >
              Open timeline
            </Button>
          )
          : (
            <Button
              size="small"
              onClick={handleOpenMediaTimeline}
              disabled={openingTimeline}
              sx={{ color: "#d1d5db", minWidth: 112 }}
            >
              {openingTimeline ? "Opening" : "Open timeline"}
            </Button>
          )}
      </Stack>
      {trackError && (
        <Typography sx={{ color: "#f87171", ml: 4, mb: 1, fontFamily: "monospace", fontSize: 12 }}>
          {trackError}
        </Typography>
      )}
      {expanded && hasRawDetails && (
        <Box
          sx={{
            m: 0,
            mb: 1,
            ml: 4,
            position: "relative",
            bgcolor: "#020617",
            border: "1px solid #1f2937",
            borderRadius: 1,
          }}
        >
          <Box
            onPointerDown={handlePayloadResizeStart}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize event payload"
            sx={{
              height: 10,
              cursor: "ns-resize",
              borderBottom: "1px solid #1f2937",
              "&::after": {
                content: '""',
                display: "block",
                width: 48,
                height: 3,
                mx: "auto",
                mt: "3px",
                borderRadius: 999,
                bgcolor: "#4b5563",
              },
            }}
          />
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1,
              height: payloadHeight,
              overflow: "auto",
              color: "#cbd5e1",
              fontFamily: "monospace",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(rawDetails, null, 2)}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export default App;
