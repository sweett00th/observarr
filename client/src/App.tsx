import SettingsIcon from "@mui/icons-material/Settings";
import SmsIcon from "@mui/icons-material/Sms";
import StorageIcon from "@mui/icons-material/Storage";
import TuneIcon from "@mui/icons-material/Tune";
import {
  AppBar,
  Box,
  Card,
  CardContent,
  Chip,
  Container,
  CssBaseline,
  Grid,
  Stack,
  ThemeProvider,
  Toolbar,
  Typography,
  createTheme
} from "@mui/material";
import { useEffect, useState } from "react";

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

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#1f6f5b"
    },
    background: {
      default: "#f5f7f8"
    }
  },
  shape: {
    borderRadius: 8
  }
});

const placeholders = [
  {
    title: "Message Receipts",
    body: "No receipt storage yet.",
    icon: <StorageIcon />
  },
  {
    title: "Notification Profiles",
    body: "Profile management will land later.",
    icon: <TuneIcon />
  },
  {
    title: "Event Templates",
    body: "Template editing is not implemented yet.",
    icon: <SmsIcon />
  },
  {
    title: "Provider Settings",
    body: "Twilio variables are read from the container environment.",
    icon: <SettingsIcon />
  }
];

function App() {
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "online" | "error">("loading");

  useEffect(() => {
    fetch("/api/version")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Backend returned ${response.status}`);
        }

        return response.json() as Promise<VersionResponse>;
      })
      .then((data) => {
        setVersion(data);
        setStatus("online");
      })
      .catch(() => {
        setStatus("error");
      });
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
        <AppBar position="static" elevation={0}>
          <Toolbar>
            <Typography variant="h6" component="h1" sx={{ fontWeight: 700 }}>
              SMS Gateway
            </Typography>
          </Toolbar>
        </AppBar>

        <Container maxWidth="lg" sx={{ py: 4 }}>
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
      </Box>
    </ThemeProvider>
  );
}

export default App;
