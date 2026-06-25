import AddIcon from "@mui/icons-material/Add";
import EmailIcon from "@mui/icons-material/Email";
import DeleteIcon from "@mui/icons-material/Delete";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import MarkEmailUnreadIcon from "@mui/icons-material/MarkEmailUnread";
import NotificationsIcon from "@mui/icons-material/Notifications";
import NotificationsOffIcon from "@mui/icons-material/NotificationsOff";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import PhoneIcon from "@mui/icons-material/Phone";
import SearchIcon from "@mui/icons-material/Search";
import {
  type TemplateCatalogEvent,
  TemplateEditorDialog,
} from "./TemplateEditorDialog";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  List,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

type IdentityProvider = "jellyfin" | "seerr";

type ProfileSummary = {
  id: number;
  displayName: string;
  enabled: boolean;
  hasAvatar: boolean;
  providers: IdentityProvider[];
  hasPhone: boolean;
  hasEmail: boolean;
  updatedAt: string;
};

type ProfileIdentity = {
  provider: IdentityProvider;
  externalUserId: string;
  username: string | null;
  email: string | null;
  lastSyncedAt: string | null;
};

type ProfilePreference = {
  source: string;
  eventType: string;
  enabled: boolean;
  notifySms: boolean;
  notifyEmail: boolean;
};

type ProfilePhoneNumber = {
  id: number;
  phoneNumber: string;
  label: string | null;
  enabled: boolean;
  optInState: "not_sent" | "pending" | "opted_in" | "opted_out" | "disabled";
  welcomeSentAt: string | null;
  optedInAt: string | null;
  optedOutAt: string | null;
  lastResponseText: string | null;
  lastResponseAt: string | null;
};

type ProfileMediaInterest = {
  id: number;
  mediaItemId: number | null;
  title: string;
  mediaType: string | null;
  tmdbId: string | null;
  year: string | null;
  enabled: boolean;
};

type PhoneReceipt = {
  id: number;
  eventTitle: string | null;
  submissionStatus: string;
  deliveryStatus: string;
  createdAt: string;
};
type ProfileDetails = {
  id: number;
  displayName: string;
  enabled: boolean;
  phoneNumber: string | null;
  emailAddress: string | null;
  avatarFilename: string | null;
  avatarContentType: string | null;
  smsOptedInAt: string | null;
  smsOptedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
  identities: ProfileIdentity[];
  preferences: ProfilePreference[];
  phoneNumbers: ProfilePhoneNumber[];
  mediaInterests: ProfileMediaInterest[];
};

type EventCatalogGroup = {
  source: string;
  label: string;
  events: TemplateCatalogEvent[];
};

type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  avatarsFetched: number;
  avatarFailures: number;
  warnings: string[];
};

type EditorState = {
  displayName: string;
  enabled: boolean;
  phoneNumber: string;
  emailAddress: string;
  jellyfinUserId: string;
  jellyfinUsername: string;
  seerrUserId: string;
  seerrUsername: string;
  seerrEmail: string;
  smsOptedIn: boolean;
  phoneNumbers: Array<{
    id?: number;
    phoneNumber: string;
    label: string;
    enabled: boolean;
    optInState?: ProfilePhoneNumber["optInState"];
    lastResponseText?: string | null;
  }>;
  preferences: Record<string, ProfilePreference>;
};

export function NotificationProfilesManager({
  open,
  profileCount,
  onClose,
  onChanged,
  onOpenMediaTimeline,
}: {
  open: boolean;
  profileCount: number;
  onClose: () => void;
  onChanged: () => void;
  onOpenMediaTimeline: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [catalog, setCatalog] = useState<EventCatalogGroup[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [details, setDetails] = useState<ProfileDetails | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<
    { severity: "success" | "error" | "info"; text: string } | null
  >(null);
  const [templateEditorEvent, setTemplateEditorEvent] = useState<
    TemplateCatalogEvent | null
  >(null);
  const [expandedPhoneId, setExpandedPhoneId] = useState<number | null>(null);
  const [phoneReceipts, setPhoneReceipts] = useState<
    Record<number, PhoneReceipt[]>
  >({});

  useEffect(() => {
    if (!open) {
      return;
    }

    fetchCatalog();
    fetchProfiles();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const timeout = window.setTimeout(fetchProfiles, 200);
    return () => window.clearTimeout(timeout);
  }, [query, open]);

  useEffect(() => {
    if (!selectedId) {
      setDetails(null);
      setEditor(null);
      return;
    }

    fetchProfile(selectedId);
  }, [selectedId, catalog]);

  const selectedSummary =
    profiles.find((profile) => profile.id === selectedId) ?? null;
  const optInTemplateEvent = findCatalogEvent(
    catalog,
    "system",
    "sms_opt_in_welcome",
  );

  async function fetchCatalog() {
    const response = await fetch("/api/event-templates/catalog");
    const data = await response.json();
    if (response.ok) {
      const groups = new Map<string, EventCatalogGroup>();
      for (const item of data.catalog as TemplateCatalogEvent[]) {
        const group = groups.get(item.source) ??
          { source: item.source, label: item.sourceLabel, events: [] };
        group.events.push(item);
        groups.set(item.source, group);
      }
      setCatalog([...groups.values()]);
    }
  }

  async function fetchProfiles() {
    setLoadingList(true);
    try {
      const response = await fetch(
        `/api/notification-profiles?query=${encodeURIComponent(query)}`,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not load profiles");
      }
      setProfiles(data.profiles);
      if (!selectedId && data.profiles[0]) {
        setSelectedId(data.profiles[0].id);
      }
    } catch (error) {
      setMessage({
        severity: "error",
        text: error instanceof Error
          ? error.message
          : "Could not load profiles",
      });
    } finally {
      setLoadingList(false);
    }
  }

  async function fetchProfile(id: number) {
    setLoadingDetails(true);
    try {
      const response = await fetch(`/api/notification-profiles/${id}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not load profile");
      }
      setDetails(data.profile);
      setEditor(toEditorState(data.profile, catalog));
    } catch (error) {
      setMessage({
        severity: "error",
        text: error instanceof Error ? error.message : "Could not load profile",
      });
    } finally {
      setLoadingDetails(false);
    }
  }

  async function createProfile() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/notification-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "New profile", enabled: true }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not create profile");
      }
      setSelectedId(data.profile.id);
      await fetchProfiles();
      onChanged();
      setMessage({ severity: "success", text: "Profile created" });
    } catch (error) {
      setMessage({
        severity: "error",
        text: error instanceof Error
          ? error.message
          : "Could not create profile",
      });
    } finally {
      setSaving(false);
    }
  }

  async function importJellyfinUsers() {
    setImporting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/jellyfin/import-users", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Jellyfin import failed");
      }
      const summary = data.summary as ImportSummary;
      await fetchProfiles();
      if (selectedId) {
        await fetchProfile(selectedId);
      }
      onChanged();
      setMessage({
        severity: "success",
        text:
          `Jellyfin import: ${summary.created} created, ${summary.updated} updated, ${summary.avatarsFetched} avatars.`,
      });
    } catch (error) {
      setMessage({
        severity: "error",
        text: error instanceof Error ? error.message : "Jellyfin import failed",
      });
    } finally {
      setImporting(false);
    }
  }

  async function saveProfile() {
    if (!details || !editor) {
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const patchResponse = await fetch(
        `/api/notification-profiles/${details.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: editor.displayName,
            enabled: editor.enabled,
            phoneNumber: editor.phoneNumbers[0]?.phoneNumber ?? "",
            emailAddress: editor.emailAddress,
            phoneNumbers: editor.phoneNumbers.map((phone) => ({
              id: phone.id,
              phoneNumber: phone.phoneNumber,
              label: phone.label,
              enabled: phone.enabled,
            })),
            identities: {
              jellyfin: editor.jellyfinUserId || editor.jellyfinUsername
                ? {
                  externalUserId: editor.jellyfinUserId,
                  username: editor.jellyfinUsername,
                }
                : null,
              seerr:
                editor.seerrUserId || editor.seerrUsername || editor.seerrEmail
                  ? {
                    externalUserId: editor.seerrUserId,
                    username: editor.seerrUsername,
                    email: editor.seerrEmail,
                  }
                  : null,
            },
          }),
        },
      );
      const patchData = await patchResponse.json();
      if (!patchResponse.ok) {
        throw new Error(patchData.error || "Could not save profile");
      }

      const preferences = Object.values(editor.preferences);
      const prefResponse = await fetch(
        `/api/notification-profiles/${details.id}/preferences`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences }),
        },
      );
      const prefData = await prefResponse.json();
      if (!prefResponse.ok) {
        throw new Error(prefData.error || "Could not save preferences");
      }

      setDetails(prefData.profile);
      setEditor(toEditorState(prefData.profile, catalog));
      await fetchProfiles();
      onChanged();
      setMessage({
        severity: "success",
        text: "Profile saved. No messages were sent.",
      });
    } catch (error) {
      setMessage({
        severity: "error",
        text: error instanceof Error ? error.message : "Could not save profile",
      });
    } finally {
      setSaving(false);
    }
  }

  const profileInitials =
    (details?.displayName || selectedSummary?.displayName || "?")
      .split(" ")
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase();

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xl">
      <DialogTitle>Notification Profiles</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Grid container sx={{ minHeight: { xs: 680, md: 720 } }}>
          <Grid
            item
            xs={12}
            md={4}
            sx={{
              borderRight: { md: "1px solid" },
              borderColor: "divider",
              p: 2,
            }}
          >
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  label="Search profiles"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  fullWidth
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  }}
                />
                <Chip label={`${profileCount} total`} size="small" />
              </Stack>
              <Stack direction="row" spacing={1}>
                <Button
                  startIcon={<AddIcon />}
                  variant="contained"
                  onClick={createProfile}
                  disabled={saving}
                >
                  Create Profile
                </Button>
                <Button
                  startIcon={<ImportExportIcon />}
                  variant="outlined"
                  onClick={importJellyfinUsers}
                  disabled={importing}
                >
                  {importing ? "Importing" : "Import Jellyfin Users"}
                </Button>
              </Stack>
              {message && (
                <Alert severity={message.severity}>{message.text}</Alert>
              )}
              <List dense sx={{ maxHeight: 555, overflowY: "auto" }}>
                {profiles.map((profile) => (
                  <ListItemButton
                    key={profile.id}
                    selected={profile.id === selectedId}
                    onClick={() => setSelectedId(profile.id)}
                    sx={{ borderRadius: 1, mb: 0.5 }}
                  >
                    <ListItemAvatar>
                      <Avatar
                        src={profile.hasAvatar
                          ? `/api/notification-profiles/${profile.id}/avatar?v=${
                            encodeURIComponent(profile.updatedAt)
                          }`
                          : undefined}
                      >
                        {initials(profile.displayName)}
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={profile.displayName}
                      secondary={
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.5 }}
                        >
                          <Chip
                            size="small"
                            label={profile.enabled ? "Enabled" : "Disabled"}
                            color={profile.enabled ? "success" : "default"}
                          />
                          {profile.providers.includes("jellyfin") && (
                            <Chip size="small" label="Jellyfin" />
                          )}
                          {profile.providers.includes("seerr") && (
                            <Chip size="small" label="Seerr" />
                          )}
                          <Chip
                            size="small"
                            icon={<PhoneIcon />}
                            label={profile.hasPhone ? "Phone" : "No phone"}
                            variant="outlined"
                          />
                          <Chip
                            size="small"
                            icon={<EmailIcon />}
                            label={profile.hasEmail ? "Email" : "No email"}
                            variant="outlined"
                          />
                        </Stack>
                      }
                    />
                  </ListItemButton>
                ))}
                {!loadingList && profiles.length === 0 && (
                  <Typography color="text.secondary" sx={{ p: 2 }}>
                    No profiles found.
                  </Typography>
                )}
              </List>
            </Stack>
          </Grid>

          <Grid item xs={12} md={8} sx={{ p: 3 }}>
            {!editor || !details
              ? (
                <Alert severity="info">
                  Select or create a notification profile.
                </Alert>
              )
              : (
                <Stack spacing={3}>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <Avatar
                      src={details.avatarFilename
                        ? `/api/notification-profiles/${details.id}/avatar?v=${
                          encodeURIComponent(details.updatedAt ?? "")
                        }`
                        : undefined}
                      sx={{ width: 72, height: 72, fontSize: 24 }}
                    >
                      {profileInitials}
                    </Avatar>
                    <Box sx={{ flexGrow: 1 }}>
                      <Typography variant="h6">
                        {details.displayName}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        Notification recipient profile. This is not an ObservaRR
                        login account.
                      </Typography>
                    </Box>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={editor.enabled}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              enabled: event.target.checked,
                            })}
                        />
                      }
                      label={editor.enabled ? "Enabled" : "Disabled"}
                    />
                  </Stack>

                  {loadingDetails && (
                    <Alert severity="info">Loading profile...</Alert>
                  )}

                  <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                      <TextField
                        label="Display name"
                        value={editor.displayName}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            displayName: event.target.value,
                          })}
                        fullWidth
                      />
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <TextField
                        label="Email address"
                        value={editor.emailAddress}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            emailAddress: event.target.value,
                          })}
                        helperText="Stored for future email delivery."
                        fullWidth
                      />
                    </Grid>
                    <Grid item xs={12}>
                      <PhoneNumbersEditor
                        profileId={details.id}
                        phones={editor.phoneNumbers}
                        expandedPhoneId={expandedPhoneId}
                        receipts={phoneReceipts}
                        onExpandedPhoneId={setExpandedPhoneId}
                        onReceipts={setPhoneReceipts}
                        onChange={(phoneNumbers) =>
                          setEditor({ ...editor, phoneNumbers })}
                        onChanged={() => fetchProfile(details.id)}
                        onEditOptInTemplate={optInTemplateEvent
                          ? () => setTemplateEditorEvent(optInTemplateEvent)
                          : undefined}
                      />
                    </Grid>
                  </Grid>

                  <Box>
                    <Typography variant="subtitle1" gutterBottom>
                      Identity mappings
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mb: 2 }}
                    >
                      Jellyfin mappings can be imported and refreshed. Seerr
                      mappings are manually editable. Mapping a user does not
                      create a login account or enable notifications.
                    </Typography>
                    <Grid container spacing={2}>
                      <Grid item xs={12} md={6}>
                        <TextField
                          label="Jellyfin user ID"
                          value={editor.jellyfinUserId}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              jellyfinUserId: event.target.value,
                            })}
                          fullWidth
                        />
                      </Grid>
                      <Grid item xs={12} md={6}>
                        <TextField
                          label="Jellyfin username"
                          value={editor.jellyfinUsername}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              jellyfinUsername: event.target.value,
                            })}
                          fullWidth
                        />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField
                          label="Seerr user ID"
                          value={editor.seerrUserId}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              seerrUserId: event.target.value,
                            })}
                          fullWidth
                        />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField
                          label="Seerr username"
                          value={editor.seerrUsername}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              seerrUsername: event.target.value,
                            })}
                          fullWidth
                        />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField
                          label="Seerr email"
                          value={editor.seerrEmail}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              seerrEmail: event.target.value,
                            })}
                          fullWidth
                        />
                      </Grid>
                    </Grid>
                  </Box>

                  <Box>
                    <Typography variant="subtitle1" gutterBottom>
                      Subscribed media
                    </Typography>
                    {details.mediaInterests.length === 0
                      ? (
                        <Alert severity="info">
                          This profile is not subscribed to any movies or series
                          yet.
                        </Alert>
                      )
                      : (
                        <Stack
                          direction="row"
                          spacing={1}
                          sx={{ flexWrap: "wrap", gap: 1 }}
                        >
                          {details.mediaInterests.map((interest) => (
                            <Chip
                              key={interest.id}
                              label={`${interest.title}${
                                interest.year ? ` (${interest.year})` : ""
                              }${
                                interest.mediaType
                                  ? ` - ${interest.mediaType}`
                                  : ""
                              }`}
                              color={interest.enabled ? "primary" : "default"}
                              variant={interest.enabled ? "filled" : "outlined"}
                              clickable={interest.mediaItemId !== null}
                              onClick={interest.mediaItemId !== null
                                ? () => {
                                  onClose();
                                  onOpenMediaTimeline(interest.mediaItemId!);
                                }
                                : undefined}
                            />
                          ))}
                        </Stack>
                      )}
                  </Box>
                  <Box>
                    <Typography variant="subtitle1" gutterBottom>
                      Event interests and delivery channels
                    </Typography>
                    {(!editor.phoneNumbers.some((phone) =>
                      phone.enabled && phone.optInState === "opted_in"
                    )) && (
                      <Alert severity="warning" sx={{ mb: 2 }}>
                        No enabled phone number has confirmed SMS opt-in. Email
                        templates are stored, but email delivery is not
                        configured yet.
                      </Alert>
                    )}
                    <Stack spacing={2}>
                      {catalog.map((group) => ({
                        ...group,
                        events: group.events.filter(isPreferenceTemplateEvent),
                      })).filter((group) => group.events.length > 0).map((
                        group,
                      ) => (
                        <Box
                          key={group.source}
                          sx={{
                            border: "1px solid",
                            borderColor: "divider",
                            borderRadius: 1,
                          }}
                        >
                          <Typography variant="subtitle2" sx={{ px: 2, py: 1 }}>
                            {group.label}
                          </Typography>
                          <Divider />
                          {group.events.map((event) => {
                            const key = preferenceKey(
                              group.source,
                              event.eventType,
                            );
                            const preference = editor.preferences[key];
                            return (
                              <Grid
                                key={key}
                                container
                                alignItems="center"
                                sx={{
                                  px: 2,
                                  py: 1,
                                  borderTop: "1px solid",
                                  borderColor: "divider",
                                }}
                              >
                                <Grid item xs={12} md={4}>
                                  <Typography>{event.label}</Typography>
                                  <Stack
                                    direction="row"
                                    spacing={0.5}
                                    sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.5 }}
                                  >
                                    <Chip
                                      size="small"
                                      label={event.template?.hasSmsTemplate
                                        ? "SMS template"
                                        : "No SMS template"}
                                      color={event.template?.hasSmsTemplate
                                        ? "success"
                                        : "default"}
                                    />
                                    <Chip
                                      size="small"
                                      label={event.template
                                          ?.hasEmailSubjectTemplate &&
                                          event.template?.hasEmailBodyTemplate
                                        ? "Email template"
                                        : "Email incomplete"}
                                      variant="outlined"
                                    />
                                    <Chip
                                      size="small"
                                      label="Email not configured"
                                      variant="outlined"
                                    />
                                  </Stack>
                                </Grid>
                                <Grid item xs={4} md={2}>
                                  <FormControlLabel
                                    control={
                                      <Checkbox
                                        checked={preference.enabled}
                                        onChange={(change) =>
                                          setPreference(
                                            editor,
                                            setEditor,
                                            key,
                                            {
                                              enabled: change.target.checked,
                                            },
                                          )}
                                      />
                                    }
                                    label="Interested"
                                  />
                                </Grid>
                                <Grid item xs={4} md={2}>
                                  <FormControlLabel
                                    control={
                                      <Checkbox
                                        checked={preference.notifySms}
                                        onChange={(change) =>
                                          setPreference(
                                            editor,
                                            setEditor,
                                            key,
                                            {
                                              notifySms: change.target.checked,
                                            },
                                          )}
                                      />
                                    }
                                    label="SMS"
                                  />
                                </Grid>
                                <Grid item xs={4} md={2}>
                                  <FormControlLabel
                                    control={
                                      <Checkbox
                                        checked={preference.notifyEmail}
                                        onChange={(change) =>
                                          setPreference(
                                            editor,
                                            setEditor,
                                            key,
                                            {
                                              notifyEmail:
                                                change.target.checked,
                                            },
                                          )}
                                      />
                                    }
                                    label="Email"
                                  />
                                </Grid>
                                <Grid item xs={12} md={2}>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={() =>
                                      setTemplateEditorEvent(event)}
                                  >
                                    Edit Template
                                  </Button>
                                </Grid>
                              </Grid>
                            );
                          })}
                        </Box>
                      ))}
                    </Stack>
                  </Box>

                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button
                      variant="outlined"
                      onClick={() =>
                        details && setEditor(toEditorState(details, catalog))}
                    >
                      Reset
                    </Button>
                    <Button
                      variant="contained"
                      onClick={saveProfile}
                      disabled={saving}
                    >
                      {saving ? "Saving" : "Save Profile"}
                    </Button>
                  </Stack>
                </Stack>
              )}
          </Grid>
        </Grid>
      </DialogContent>
      <TemplateEditorDialog
        open={Boolean(templateEditorEvent)}
        catalogEvent={templateEditorEvent}
        onClose={() => setTemplateEditorEvent(null)}
        onSaved={fetchCatalog}
      />
    </Dialog>
  );
}

export function NotificationProfilesActions({
  count,
  onManage,
  onImported,
}: {
  count: number;
  onManage: () => void;
  onImported: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function importUsers() {
    setImporting(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/integrations/jellyfin/import-users", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Jellyfin import failed");
      }
      const summary = data.summary as ImportSummary;
      setMessage(
        `${summary.created} created, ${summary.updated} updated, ${summary.avatarsFetched} avatars fetched.`,
      );
      onImported();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Jellyfin import failed",
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {count} profiles configured.
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        <Button size="small" variant="outlined" onClick={onManage}>
          Manage Profiles
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={importUsers}
          disabled={importing}
        >
          {importing ? "Importing" : "Import Jellyfin Users"}
        </Button>
      </Box>
      {message && <Alert severity="success">{message}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

function findCatalogEvent(
  catalog: EventCatalogGroup[],
  source: string,
  eventType: string,
): TemplateCatalogEvent | null {
  for (const group of catalog) {
    const event = group.events.find((item) =>
      item.source === source && item.eventType === eventType
    );
    if (event) return event;
  }
  return null;
}

function isPreferenceTemplateEvent(event: TemplateCatalogEvent): boolean {
  return !(event.source === "system" &&
    event.eventType === "sms_opt_in_welcome");
}
function toEditorState(
  profile: ProfileDetails,
  catalog: EventCatalogGroup[],
): EditorState {
  const identityByProvider = new Map(
    profile.identities.map((identity) => [identity.provider, identity]),
  );
  const preferenceMap = new Map(
    profile.preferences.map((
      preference,
    ) => [preferenceKey(preference.source, preference.eventType), preference]),
  );
  const preferences: Record<string, ProfilePreference> = {};

  for (const group of catalog) {
    for (const event of group.events.filter(isPreferenceTemplateEvent)) {
      const key = preferenceKey(group.source, event.eventType);
      preferences[key] = preferenceMap.get(key) ?? {
        source: group.source,
        eventType: event.eventType,
        enabled: false,
        notifySms: false,
        notifyEmail: false,
      };
    }
  }

  const jellyfin = identityByProvider.get("jellyfin");
  const seerr = identityByProvider.get("seerr");

  return {
    displayName: profile.displayName,
    enabled: profile.enabled,
    phoneNumber: profile.phoneNumber ?? "",
    emailAddress: profile.emailAddress ?? "",
    jellyfinUserId: jellyfin?.externalUserId ?? "",
    jellyfinUsername: jellyfin?.username ?? "",
    seerrUserId: seerr?.externalUserId ?? "",
    seerrUsername: seerr?.username ?? "",
    seerrEmail: seerr?.email ?? "",
    smsOptedIn: Boolean(profile.smsOptedInAt && !profile.smsOptedOutAt),
    phoneNumbers: (profile.phoneNumbers ?? []).map((phone) => ({
      id: phone.id,
      phoneNumber: phone.phoneNumber,
      label: phone.label ?? "",
      enabled: phone.enabled,
      optInState: phone.optInState,
      lastResponseText: phone.lastResponseText,
    })),
    preferences,
  };
}

function setPreference(
  editor: EditorState,
  setEditor: (editor: EditorState) => void,
  key: string,
  patch: Partial<ProfilePreference>,
) {
  setEditor({
    ...editor,
    preferences: {
      ...editor.preferences,
      [key]: {
        ...editor.preferences[key],
        ...patch,
      },
    },
  });
}

function preferenceKey(source: string, eventType: string): string {
  return `${source}:${eventType}`;
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
}

type PhoneNumbersEditorProps = {
  profileId: number;
  phones: EditorState["phoneNumbers"];
  expandedPhoneId: number | null;
  receipts: Record<number, PhoneReceipt[]>;
  onExpandedPhoneId: (id: number | null) => void;
  onReceipts: (receipts: Record<number, PhoneReceipt[]>) => void;
  onChange: (phones: EditorState["phoneNumbers"]) => void;
  onChanged: () => void;
  onEditOptInTemplate?: () => void;
};

function PhoneNumbersEditor(props: PhoneNumbersEditorProps) {
  const {
    profileId,
    phones,
    expandedPhoneId,
    receipts,
    onExpandedPhoneId,
    onReceipts,
    onChange,
    onChanged,
    onEditOptInTemplate,
  } = props;
  const [sendError, setSendError] = useState<string | null>(null);

  async function sendWelcome(phoneId: number) {
    setSendError(null);
    try {
      const response = await fetch(
        `/api/notification-profiles/${profileId}/phone-numbers/${phoneId}/send-opt-in`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        setSendError(data.error || "Could not send opt-in text");
        return;
      }
      onChanged();
    } catch {
      setSendError("Could not send opt-in text");
    }
  }

  async function sendAllPending() {
    setSendError(null);
    try {
      const response = await fetch(
        `/api/notification-profiles/${profileId}/phone-numbers/send-pending-opt-ins`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        setSendError(data.error || "Could not send opt-in texts");
        return;
      }
      onChanged();
    } catch {
      setSendError("Could not send opt-in texts");
    }
  }

  async function toggleReceipts(phoneId?: number) {
    if (!phoneId) return;
    if (expandedPhoneId === phoneId) {
      onExpandedPhoneId(null);
      return;
    }
    const response = await fetch(
      `/api/notification-profiles/${profileId}/phone-numbers/${phoneId}/receipts`,
    );
    const data = await response.json();
    if (response.ok) {
      onReceipts({ ...receipts, [phoneId]: data.receipts });
      onExpandedPhoneId(phoneId);
    }
  }

  function update(
    index: number,
    patch: Partial<EditorState["phoneNumbers"][number]>,
  ) {
    onChange(
      phones.map((phone, phoneIndex) =>
        phoneIndex === index ? { ...phone, ...patch } : phone
      ),
    );
  }

  return (
    <Stack spacing={1.25}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        alignItems={{ xs: "stretch", sm: "center" }}
        justifyContent="space-between"
      >
        <Box>
          <Typography variant="subtitle2">Phone numbers</Typography>
          <Typography variant="caption" color="text.secondary">
            Each number has its own opt-in state and dispatch toggle.
          </Typography>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          justifyContent={{ xs: "flex-start", sm: "flex-end" }}
        >
          {onEditOptInTemplate && (
            <Button
              size="small"
              variant="outlined"
              onClick={onEditOptInTemplate}
            >
              Edit opt-in template
            </Button>
          )}
          <Button size="small" variant="outlined" onClick={sendAllPending}>
            Send pending opt-ins
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() =>
              onChange([...phones, {
                phoneNumber: "",
                label: "",
                enabled: true,
                optInState: "not_sent",
              }])}
          >
            Add
          </Button>
        </Stack>
      </Stack>
      {sendError && (
        <Alert severity="error" onClose={() => setSendError(null)}>
          {sendError}
        </Alert>
      )}
      {phones.length === 0 && (
        <Alert severity="info">
          No phone numbers. Add a number, save the profile, then send its opt-in
          text.
        </Alert>
      )}
      <Stack spacing={1}>
        {phones.map((phone, index) => {
          const icon = phoneIcon(phone);
          return (
            <Box
              key={phone.id ?? `new-${index}`}
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                px: { xs: 1.25, md: 1.5 },
                py: 1.25,
                bgcolor: "background.paper",
              }}
            >
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "32px 1fr",
                    md:
                      "32px minmax(220px, 1.2fr) minmax(150px, 0.8fr) 132px minmax(220px, 1fr) auto",
                  },
                  columnGap: 1.25,
                  rowGap: 1,
                  alignItems: "start",
                }}
              >
                <IconButton
                  size="small"
                  disabled={!phone.id}
                  onClick={() => toggleReceipts(phone.id)}
                  title={phone.id
                    ? "Show receipts"
                    : "Save profile before viewing receipts"}
                  sx={{ mt: 0.75 }}
                >
                  {icon}
                </IconButton>
                <TextField
                  size="small"
                  label="Phone"
                  value={phone.phoneNumber}
                  onChange={(event) =>
                    update(index, { phoneNumber: event.target.value })}
                  placeholder="5555551234"
                  helperText="10-digit U.S. or +country code"
                  fullWidth
                  sx={{ gridColumn: { xs: "2 / 3", md: "auto" } }}
                />
                <TextField
                  size="small"
                  label="Label"
                  value={phone.label}
                  onChange={(event) =>
                    update(index, { label: event.target.value })}
                  placeholder="Mobile"
                  fullWidth
                  sx={{ gridColumn: { xs: "2 / 3", md: "auto" } }}
                />
                <FormControlLabel
                  sx={{
                    m: 0,
                    gridColumn: { xs: "2 / 3", md: "auto" },
                    minHeight: 40,
                    whiteSpace: "nowrap",
                  }}
                  control={
                    <Switch
                      size="small"
                      checked={phone.enabled}
                      onChange={(event) =>
                        update(index, { enabled: event.target.checked })}
                    />
                  }
                  label={phone.enabled ? "Enabled" : "Disabled"}
                />
                <Box
                  sx={{
                    gridColumn: { xs: "2 / 3", md: "auto" },
                    lineHeight: 1.35,
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                  >
                    {phoneStateLabel(phone)}
                  </Typography>
                  {phone.lastResponseText && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                    >
                      Last reply: {phone.lastResponseText}
                    </Typography>
                  )}
                </Box>
                <Stack
                  direction="row"
                  spacing={0.5}
                  justifyContent={{ xs: "flex-start", md: "flex-end" }}
                  sx={{ gridColumn: { xs: "2 / 3", md: "auto" } }}
                >
                  {phone.id && phone.optInState === "not_sent" && (
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => sendWelcome(phone.id!)}
                      sx={{ whiteSpace: "nowrap" }}
                    >
                      Send opt-in
                    </Button>
                  )}
                  <IconButton
                    size="small"
                    onClick={() =>
                      onChange(
                        phones.filter((_, phoneIndex) => phoneIndex !== index),
                      )}
                    title="Remove phone"
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Box>
              {phone.id && expandedPhoneId === phone.id && (
                <Box
                  sx={{
                    mt: 1,
                    ml: { xs: 5, md: 4 },
                    pt: 1,
                    borderTop: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  {(receipts[phone.id] ?? []).length === 0
                    ? (
                      <Typography variant="caption" color="text.secondary">
                        No receipts for this number.
                      </Typography>
                    )
                    : (receipts[phone.id] ?? []).map((receipt) => (
                      <Typography
                        key={receipt.id}
                        variant="caption"
                        display="block"
                        color="text.secondary"
                      >
                        {new Date(receipt.createdAt).toLocaleString()} -{" "}
                        {receipt.eventTitle ?? "SMS"} -{" "}
                        {receipt.submissionStatus}/{receipt.deliveryStatus}
                      </Typography>
                    ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Stack>
    </Stack>
  );
}

function phoneIcon(
  phone: { enabled: boolean; optInState?: ProfilePhoneNumber["optInState"] },
) {
  if (
    !phone.enabled || phone.optInState === "disabled" ||
    phone.optInState === "opted_out"
  ) {
    return <NotificationsOffIcon color="disabled" fontSize="small" />;
  }
  if (phone.optInState === "opted_in") {
    return <NotificationsIcon color="success" fontSize="small" />;
  }
  if (phone.optInState === "pending") {
    return <HourglassEmptyIcon color="warning" fontSize="small" />;
  }
  return <MarkEmailUnreadIcon color="action" fontSize="small" />;
}

function phoneStateLabel(
  phone: { enabled: boolean; optInState?: ProfilePhoneNumber["optInState"] },
) {
  if (!phone.enabled || phone.optInState === "disabled") {
    return "Disabled for SMS dispatch.";
  }
  if (phone.optInState === "opted_in") return "Confirmed opt-in.";
  if (phone.optInState === "opted_out") return "Opted out.";
  if (phone.optInState === "pending") {
    return "Opt-in text sent; awaiting reply.";
  }
  return "Opt-in welcome text has not been sent.";
}
