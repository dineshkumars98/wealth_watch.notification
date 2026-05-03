require('dotenv').config();
const express = require('express');

const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Firebase Admin securely using Environment Variables
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    // Fix for "Invalid PEM formatted message" error
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize Firebase Admin:", error);
  }
}

// Initialize Firestore
const db = admin.firestore();

// Middleware to authenticate requests using Firebase ID Tokens
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ success: false, error: 'No token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Add user info to the request object
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).send({ success: false, error: 'Unauthorized' });
  }
};

app.post('/send-notification', authenticate, async (req, res) => {
  try {
    const { token, title, body, data } = req.body;
    const message = {
      token: token,
      notification: { title, body },
      data: data
    };

    const response = await admin.messaging().send(message);
    res.status(200).send({ success: true, response });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).send({ success: false, error: error.message });
  }
});

// Endpoint to store user details (Firestore Persistence with Duplicate Checking)
app.post('/store-user', async (req, res) => {
  try {
    const { uid, name, email, phoneNumber, fcmToken, ...otherDetails } = req.body;

    // 1. Validate Mandatory Fields
    if (!uid || !name || !fcmToken || (!email && !phoneNumber)) {
      return res.status(400).send({ 
        success: false, 
        error: "Missing required fields: uid, name, fcmToken, and at least one identity (email or phoneNumber) are mandatory." 
      });
    }

    // 2. Duplicate Checking Logic
    const usersRef = db.collection('users');
    
    // Check Email Duplicate
    if (email) {
      const emailQuery = await usersRef.where('email', '==', email).get();
      const duplicate = emailQuery.docs.find(doc => doc.id !== uid);
      if (duplicate) {
        return res.status(409).send({ success: false, error: "A user with this email already exists." });
      }
    }

    // Check Phone Number Duplicate
    if (phoneNumber) {
      const phoneQuery = await usersRef.where('phoneNumber', '==', phoneNumber).get();
      const duplicate = phoneQuery.docs.find(doc => doc.id !== uid);
      if (duplicate) {
        return res.status(409).send({ success: false, error: "A user with this phone number already exists." });
      }
    }

    const userData = {
      uid,
      name,
      email: email || null,
      phoneNumber: phoneNumber || null,
      fcmToken,
      ...otherDetails,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Save to Firestore
    await usersRef.doc(uid).set(userData, { merge: true });

    console.log(`User saved/updated in Firestore: ${name} (${uid})`);
    res.status(200).send({ success: true, message: "User details saved permanently" });
  } catch (error) {
    console.error("Error storing user in Firestore:", error);
    res.status(500).send({ success: false, error: error.message });
  }
});

// Endpoint to delete a user by their FCM Token
app.delete('/delete-user-by-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).send({ success: false, error: "fcmToken is required to delete a user." });
    }

    const snapshot = await db.collection('users').where('fcmToken', '==', fcmToken).get();

    if (snapshot.empty) {
      return res.status(404).send({ success: false, error: "No user found with this FCM Token." });
    }

    // Delete all matching documents (usually there's only one)
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    res.status(200).send({ success: true, message: `Deleted ${snapshot.size} user(s) associated with this token.` });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// Endpoint to find a user by email or phone number
app.get('/find-user', authenticate, async (req, res) => {
  try {
    const { identity } = req.query;

    if (!identity) {
      return res.status(400).send({ success: false, error: "Identity query parameter is required" });
    }

    const searchIdentity = identity.trim();
    console.log(`Searching Firestore for identity: "${searchIdentity}"`);

    // Search by Email
    let userQuery = await db.collection('users').where('email', '==', searchIdentity).get();
    
    // If not found, search by Phone Number (Normalized)
    if (userQuery.empty) {
      userQuery = await db.collection('users').where('phoneNumber', '==', searchIdentity).get();
    }

    if (userQuery.empty) {
      return res.status(404).send({ success: false, error: "User not found" });
    }

    const user = userQuery.docs[0].data();
    res.status(200).send({ 
      success: true, 
      data: {
        uid: user.uid,
        name: user.name,
        fcmToken: user.fcmToken
      }
    });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// Endpoint to retrieve a specific user by UID
app.get('/get-user/:uid', authenticate, async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).send({ success: false, error: "User not found" });
    }

    res.status(200).send({ success: true, data: userDoc.data() });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

// Endpoint to list all users
app.get('/list-users', authenticate, async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => {
      const u = doc.data();
      return {
        uid: u.uid,
        name: u.name,
        email: u.email,
        phoneNumber: u.phoneNumber,
        fcmToken: u.fcmToken
      };
    });

    res.status(200).send({ success: true, count: users.length, users });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
